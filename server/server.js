import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import initSqlJs from "sql.js";
import { Server } from "socket.io";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import webpush from "web-push";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "local-connecthub-secret-change-before-deploy");
if (!JWT_SECRET || (process.env.NODE_ENV === "production" && JWT_SECRET.length < 32)) {
  throw new Error("Set JWT_SECRET to a random secret of at least 32 characters before production deployment.");
}
const DB_FILE = path.join(DATA_DIR, "connecthub.sqlite");
const SQL = await initSqlJs();
let db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();

db.run(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password TEXT NOT NULL, bio TEXT DEFAULT '', avatar TEXT DEFAULT '',
 status TEXT DEFAULT 'offline', last_seen TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, name TEXT DEFAULT '', is_group INTEGER DEFAULT 0,
 group_admin TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS participants (
 conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, cleared_at TEXT,
 PRIMARY KEY(conversation_id,user_id),
 FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
 content TEXT DEFAULT '', type TEXT DEFAULT 'text', file_name TEXT DEFAULT '',
 file_url TEXT DEFAULT '', file_size INTEGER DEFAULT 0, mime_type TEXT DEFAULT '',
 is_read INTEGER DEFAULT 0, is_delivered INTEGER DEFAULT 0, is_edited INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0, reply_to TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP, edited_at TEXT,
 FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
 FOREIGN KEY(sender_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS devices (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
 created_at TEXT NOT NULL, last_active TEXT NOT NULL, revoked_at TEXT,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pairings (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
 device_name TEXT DEFAULT 'Mobile device', status TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, requested_at TEXT,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subscription TEXT NOT NULL,
 created_at TEXT NOT NULL, UNIQUE(user_id, subscription)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id,created_at);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);
CREATE TABLE IF NOT EXISTS hidden_messages (
 message_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(message_id,user_id)
);
`);
// Additive migrations preserve existing 2.x accounts and message history.
try { db.run("ALTER TABLE participants ADD COLUMN cleared_at TEXT"); } catch {}
try { db.run("ALTER TABLE messages ADD COLUMN reply_to TEXT"); } catch {}
try { db.run("ALTER TABLE messages ADD COLUMN is_delivered INTEGER DEFAULT 0"); } catch {}
function saveDB() { fs.writeFileSync(DB_FILE, Buffer.from(db.export())); }
function rows(sql, params = []) {
 const stmt = db.prepare(sql); stmt.bind(params); const out = [];
 while (stmt.step()) out.push(stmt.getAsObject()); stmt.free(); return out;
}
function one(sql, params = []) { return rows(sql, params)[0] || null; }
function run(sql, params = []) { db.run(sql, params); saveDB(); }
const uid = () => crypto.randomUUID();
const safeUser = u => u && ({ id:u.id, name:u.name, email:u.email, bio:u.bio || "", avatar:u.avatar || "", status:u.status, lastSeen:u.last_seen });
const tokenFor = u => jwt.sign({ id:u.id }, JWT_SECRET, { expiresIn:"1d" });
function auth(req,res,next) {
 try {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i,"");
  if (!token) return res.status(401).json({message:"Please sign in to continue."});
  req.user = jwt.verify(token, JWT_SECRET);
  if (req.user.deviceId) {
   const device = one("SELECT id FROM devices WHERE id=? AND user_id=? AND revoked_at IS NULL", [req.user.deviceId, req.user.id]);
   if (!device) return res.status(401).json({message:"This device session has been revoked. Please pair again."});
   db.run("UPDATE devices SET last_active=? WHERE id=?", [new Date().toISOString(), req.user.deviceId]); saveDB();
  }
  next();
 } catch { return res.status(401).json({message:"Your session expired. Please sign in again."}); }
}
function isMember(conversationId,userId) {
 return !!one("SELECT 1 FROM participants WHERE conversation_id=? AND user_id=?", [conversationId,userId]);
}
function lastVisible(conversationId,userId,limit=1) {
 const cleared=one("SELECT cleared_at FROM participants WHERE conversation_id=? AND user_id=?",[conversationId,userId])?.cleared_at||null;
 return rows(`SELECT * FROM messages WHERE conversation_id=? AND id NOT IN (SELECT message_id FROM hidden_messages WHERE user_id=?)${cleared?" AND created_at>?":""} ORDER BY created_at DESC LIMIT ${Number(limit)||1}`,
  cleared?[conversationId,userId,cleared]:[conversationId,userId]);
}
function removeUploadedFile(fileUrl) {
 if (!fileUrl) return;
 try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(fileUrl))); } catch {}
}
function conversationView(c,userId) {
 const members = rows(`SELECT u.id,u.name,u.email,u.avatar,u.status,u.last_seen FROM users u
 JOIN participants p ON p.user_id=u.id WHERE p.conversation_id=?`,[c.id]).map(safeUser);
 const last = lastVisible(c.id,userId,1)[0] || null;
 const others = members.filter(m=>m.id!==userId);
 return { id:c.id, name:c.is_group ? c.name : (others[0]?.name || "Conversation"),
  isGroup:!!c.is_group, groupAdmin:c.group_admin, members, unreadCount:one("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND sender_id<>? AND is_read=0 AND is_deleted=0",[c.id,userId])?.n||0, lastMessage:last ? messageView(last) : null, updatedAt:c.updated_at };
}
function messageView(m) {
 const sender = one("SELECT id,name,avatar FROM users WHERE id=?",[m.sender_id]);
 return { id:m.id, conversationId:m.conversation_id, sender: sender ? {id:sender.id,name:sender.name,avatar:sender.avatar} : null,
  content:m.is_deleted ? "This message was deleted" : m.content, type:m.type, fileName:m.file_name,
  fileUrl:m.file_url, fileSize:m.file_size, mimeType:m.mime_type, isRead:!!m.is_read, isDelivered:!!m.is_delivered, replyTo:m.reply_to?(()=>{const q=one("SELECT content,sender_id,file_name FROM messages WHERE id=?",[m.reply_to]);const u=q?one("SELECT name FROM users WHERE id=?",[q.sender_id]):null;return q?{content:q.content||q.file_name||"Attachment",senderName:u?.name||"Message"}:null;})():null,
  isEdited:!!m.is_edited, isDeleted:!!m.is_deleted, createdAt:m.created_at };
}
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false, message: { message: "Too many sign-in attempts. Please try again later." } }));
const allowedOrigins = [...(process.env.CLIENT_URL || "http://localhost:5173").split(","), process.env.RENDER_EXTERNAL_URL || ""].map(s=>s.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error("Origin not allowed by ConnectHub CORS policy."));
}, credentials:true }));
app.use(express.json({limit:"2mb"}));
app.use("/api/messages",rateLimit({windowMs:60*1000,limit:90,standardHeaders:"draft-7",legacyHeaders:false}));
app.use("/api/pair/request",rateLimit({windowMs:60*1000,limit:12,standardHeaders:"draft-7",legacyHeaders:false}));
app.use("/api/pair/complete",rateLimit({windowMs:60*1000,limit:50,standardHeaders:"draft-7",legacyHeaders:false}));
app.use("/uploads", express.static(UPLOAD_DIR));
const CLIENT_DIST = path.resolve(__dirname, "../client/dist");
if (process.env.NODE_ENV === "production" && fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
}
app.get("/", (_req,res)=>{
  if (process.env.NODE_ENV === "production" && fs.existsSync(path.join(CLIENT_DIST,"index.html"))) return res.sendFile(path.join(CLIENT_DIST,"index.html"));
  res.json({name:"ConnectHub API",status:"running"});
});
app.get("/api/health", (_req,res)=>res.json({success:true,status:"healthy",database:"SQLite"}));
app.get("/api/config",auth,rateLimit({windowMs:60*1000,limit:30}),(_req,res)=>{
 const iceServers=[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun1.l.google.com:19302"}];
 if(process.env.TURN_URL&&process.env.TURN_SHARED_SECRET){
  const expiry=Math.floor(Date.now()/1000)+3600,username=`${expiry}:connecthub`;
  const credential=crypto.createHmac("sha1",process.env.TURN_SHARED_SECRET).update(username).digest("base64");
  iceServers.push({urls:process.env.TURN_URL,username,credential});
 }
 res.json({iceServers});
});
const vapidReady=!!(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY);
if(vapidReady)webpush.setVapidDetails(process.env.VAPID_SUBJECT||"mailto:admin@example.com",process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
app.get("/api/push/public-key",(_req,res)=>res.json({publicKey:vapidReady?process.env.VAPID_PUBLIC_KEY:null,enabled:vapidReady}));
app.post("/api/push/subscribe",auth,(req,res)=>{
 if(!vapidReady)return res.status(503).json({message:"Push service is not configured. Add VAPID keys to the server environment."});
 const sub=req.body.subscription;
 if(!sub?.endpoint||!sub?.keys?.p256dh||!sub?.keys?.auth)return res.status(400).json({message:"Invalid push subscription."});
 db.run("INSERT OR REPLACE INTO push_subscriptions(id,user_id,subscription,created_at) VALUES(?,?,?,?)",[uid(),req.user.id,JSON.stringify(sub),new Date().toISOString()]);saveDB();res.json({success:true});
});

const storage = multer.diskStorage({
 destination: (_req,_file,cb)=>cb(null,UPLOAD_DIR),
 filename: (_req,file,cb)=>cb(null, `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${path.extname(file.originalname).slice(0,12)}`)
});
const upload = multer({storage,limits:{fileSize:15*1024*1024},fileFilter:(_req,file,cb)=>{
 const allowedMime = /^(image\/(jpeg|png|gif|webp)|application\/pdf|application\/(msword|vnd.openxmlformats-officedocument\.wordprocessingml\.document|zip|x-zip-compressed)|text\/plain)$/i;
 const allowedExt = /\.(jpe?g|png|gif|webp|pdf|doc|docx|zip|txt)$/i.test(file.originalname);
 const valid=allowedMime.test(file.mimetype)&&allowedExt;
 cb(valid ? null : new Error("File type not supported."), valid);
}});

app.post("/api/auth/register",(req,res)=>{
 try {
  const name=String(req.body.name||"").trim(), email=String(req.body.email||"").trim().toLowerCase(), password=String(req.body.password||"");
  if(name.length<2||name.length>50) return res.status(400).json({message:"Name must be 2–50 characters."});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({message:"Enter a valid email address."});
  if(password.length<8) return res.status(400).json({message:"Password must contain at least 8 characters."});
  if(one("SELECT id FROM users WHERE email=?",[email])) return res.status(409).json({message:"An account with this email already exists."});
  const id=uid(), hash=bcrypt.hashSync(password,12);
  run("INSERT INTO users(id,name,email,password,status) VALUES(?,?,?,?,?)",[id,name,email,hash,"online"]);
  const user=one("SELECT * FROM users WHERE id=?",[id]); res.status(201).json({token:tokenFor(user),user:safeUser(user)});
 } catch(e){res.status(500).json({message:e.message});}
});
app.post("/api/auth/login",(req,res)=>{
 const email=String(req.body.email||"").trim().toLowerCase(), password=String(req.body.password||"");
 const user=one("SELECT * FROM users WHERE email=?",[email]);
 if(!user||!bcrypt.compareSync(password,user.password)) return res.status(401).json({message:"Invalid email or password."});
 run("UPDATE users SET status='online',last_seen=NULL WHERE id=?",[user.id]);
 const fresh=one("SELECT * FROM users WHERE id=?",[user.id]); res.json({token:tokenFor(fresh),user:safeUser(fresh)});
});
app.post("/api/auth/logout",auth,(req,res)=>{
 if((online.get(req.user.id)?.size||0)<=1)run("UPDATE users SET status='offline',last_seen=? WHERE id=?",[new Date().toISOString(),req.user.id]); res.json({success:true});
});
app.get("/api/users/me",auth,(req,res)=>{const u=one("SELECT * FROM users WHERE id=?",[req.user.id]); res.json({user:safeUser(u)});});
app.put("/api/users/me",auth,upload.single("avatar"),(req,res)=>{
 const name=String(req.body.name||"").trim(), bio=String(req.body.bio||"").trim();
 if(name.length<2||name.length>50||bio.length>160) return res.status(400).json({message:"Check your name and bio length."});
 if(req.file&&!req.file.mimetype.startsWith("image/")){fs.unlinkSync(req.file.path);return res.status(400).json({message:"Profile pictures must be image files."});}
 const avatar=req.file?`/uploads/${req.file.filename}`:one("SELECT avatar FROM users WHERE id=?",[req.user.id]).avatar;
 run("UPDATE users SET name=?,bio=?,avatar=? WHERE id=?",[name,bio,avatar,req.user.id]);
 res.json({user:safeUser(one("SELECT * FROM users WHERE id=?",[req.user.id]))});
});
// Secure QR pairing: the QR contains only a short-lived random bearer secret.
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const deviceTokenFor = (user, deviceId) => jwt.sign({id:user.id,deviceId}, JWT_SECRET, {expiresIn:"30d"});
app.post("/api/devices/pairings", auth, rateLimit({windowMs:60*1000,limit:10}), (req,res)=>{
 const raw = crypto.randomBytes(32).toString("base64url"), id=uid(), now=Date.now();
 const created=new Date(now).toISOString(), expires=new Date(now+3*60*1000).toISOString();
 db.run("INSERT INTO pairings(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)",[id,sha256(raw),req.user.id,created,expires]); saveDB();
 res.status(201).json({id,token:raw,expiresAt:expires,scanUrl:`${(process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || req.headers.origin || "").replace(/\/+$/,"")}/?pair=${encodeURIComponent(raw)}`});
});
app.get("/api/devices/pairings/:id", auth, (req,res)=>{
 const p=one("SELECT id,status,device_name,expires_at,requested_at,user_id FROM pairings WHERE id=? AND user_id=?",[req.params.id,req.user.id]);
 if(!p)return res.status(404).json({message:"Pairing request not found."});
 if(Date.now()>Date.parse(p.expires_at)&&p.status!=="completed"){db.run("UPDATE pairings SET status='expired' WHERE id=?",[p.id]);saveDB();p.status="expired";}
 res.json({status:p.status,deviceName:p.device_name,expiresAt:p.expires_at});
});
app.post("/api/devices/pairings/:id/approve", auth, (req,res)=>{
 const p=one("SELECT * FROM pairings WHERE id=? AND user_id=?",[req.params.id,req.user.id]);
 if(!p||p.status!=="requested"||Date.now()>Date.parse(p.expires_at))return res.status(400).json({message:"No active device request is waiting for approval."});
 db.run("UPDATE pairings SET status='approved' WHERE id=?",[p.id]);saveDB();res.json({success:true});
});
app.post("/api/devices/pairings/:id/reject", auth, (req,res)=>{
 db.run("UPDATE pairings SET status='rejected' WHERE id=? AND user_id=?",[req.params.id,req.user.id]);saveDB();res.json({success:true});
});
app.post("/api/pair/request",rateLimit({windowMs:60*1000,limit:12}), (req,res)=>{
 const raw=String(req.body.token||""),name=String(req.body.deviceName||"Mobile device").trim().slice(0,60);
 if(raw.length<32)return res.status(400).json({message:"Invalid pairing link."});
 const p=one("SELECT * FROM pairings WHERE token_hash=?",[sha256(raw)]);
 if(!p||p.status!=="pending"||Date.now()>Date.parse(p.expires_at))return res.status(410).json({message:"This QR code has expired or was already used."});
 db.run("UPDATE pairings SET status='requested',device_name=?,requested_at=? WHERE id=? AND status='pending'",[name||"Mobile device",new Date().toISOString(),p.id]);saveDB();
 res.json({success:true,pairingId:p.id});
});
app.post("/api/pair/complete",(req,res)=>{
 const raw=String(req.body.token||"");
 const p=one("SELECT * FROM pairings WHERE token_hash=?",[sha256(raw)]);
 if(!p||Date.now()>Date.parse(p.expires_at))return res.status(410).json({message:"This pairing request has expired. Create a new QR code."});
 if(p.status==="rejected")return res.status(403).json({message:"The desktop user rejected this device request."});
 if(p.status!=="approved")return res.status(409).json({message:"Waiting for desktop approval."});
 const deviceId=uid(),now=new Date().toISOString(),user=one("SELECT * FROM users WHERE id=?",[p.user_id]);
 db.run("INSERT INTO devices(id,user_id,name,created_at,last_active) VALUES(?,?,?,?,?)",[deviceId,p.user_id,p.device_name,now,now]);
 db.run("UPDATE pairings SET status='completed',token_hash=? WHERE id=?",[sha256(crypto.randomBytes(32).toString("hex")),p.id]);saveDB();
 res.json({token:deviceTokenFor(user,deviceId),user:safeUser(user),deviceId});
});
app.get("/api/devices",auth,(req,res)=>res.json({devices:rows("SELECT id,name,created_at,last_active FROM devices WHERE user_id=? AND revoked_at IS NULL ORDER BY last_active DESC",[req.user.id])}));
app.delete("/api/devices/:id",auth,(req,res)=>{
 const result=one("SELECT id FROM devices WHERE id=? AND user_id=? AND revoked_at IS NULL",[req.params.id,req.user.id]);
 if(!result)return res.status(404).json({message:"Device not found."});
 db.run("UPDATE devices SET revoked_at=? WHERE id=?",[new Date().toISOString(),result.id]);saveDB();for(const sock of io.sockets.sockets.values())if(sock.user?.deviceId===result.id)sock.disconnect(true);res.json({success:true});
});
app.get("/api/users",auth,(req,res)=>{
 const q=`%${String(req.query.search||"").trim().toLowerCase()}%`;
 const users=rows("SELECT * FROM users WHERE id<>? AND (lower(name) LIKE ? OR lower(email) LIKE ?) ORDER BY name LIMIT 40",[req.user.id,q,q]).map(safeUser);
 res.json({users});
});
app.get("/api/conversations",auth,(req,res)=>{
 const cs=rows(`SELECT c.* FROM conversations c JOIN participants p ON p.conversation_id=c.id
 WHERE p.user_id=? ORDER BY c.updated_at DESC`,[req.user.id]);
 res.json({conversations:cs.map(c=>conversationView(c,req.user.id))});
});
app.post("/api/conversations",auth,(req,res)=>{
 const target=String(req.body.userId||"");
 if(!one("SELECT id FROM users WHERE id=?",[target])||target===req.user.id) return res.status(400).json({message:"Choose a valid person."});
 const existing=rows(`SELECT c.* FROM conversations c JOIN participants a ON a.conversation_id=c.id
 JOIN participants b ON b.conversation_id=c.id WHERE c.is_group=0 AND a.user_id=? AND b.user_id=?`,[req.user.id,target])[0];
 if(existing) return res.json({conversation:conversationView(existing,req.user.id)});
 const id=uid(); db.run("INSERT INTO conversations(id,is_group) VALUES(?,0)",[id]);
 db.run("INSERT INTO participants(conversation_id,user_id) VALUES(?,?),(?,?)",[id,req.user.id,id,target]); saveDB();
 const view = conversationView(one("SELECT * FROM conversations WHERE id=?",[id]),req.user.id);
 io.to(`user:${target}`).emit("conversation:new",{memberIds:[req.user.id,target],conversation:view});
 io.to(`user:${req.user.id}`).emit("conversation:new",{memberIds:[req.user.id,target],conversation:view});
 res.status(201).json({conversation:view});
});
app.post("/api/conversations/group",auth,(req,res)=>{
 const name=String(req.body.name||"").trim(), ids=[...new Set((req.body.memberIds||[]).filter(x=>typeof x==="string"&&x!==req.user.id))];
 if(!name||name.length>60||!ids.length) return res.status(400).json({message:"Enter a group name and select at least one member."});
 for(const id of ids) if(!one("SELECT id FROM users WHERE id=?",[id])) return res.status(400).json({message:"One selected member does not exist."});
 const id=uid(); db.run("INSERT INTO conversations(id,name,is_group,group_admin) VALUES(?,?,1,?)",[id,name,req.user.id]);
 for(const member of [req.user.id,...ids]) db.run("INSERT INTO participants(conversation_id,user_id) VALUES(?,?)",[id,member]);
 saveDB(); const c=one("SELECT * FROM conversations WHERE id=?",[id]); const view=conversationView(c,req.user.id);
 [req.user.id,...ids].forEach(memberId=>io.to(`user:${memberId}`).emit("conversation:new",{memberIds:[req.user.id,...ids],conversation:view}));
 res.status(201).json({conversation:view});
});
app.put("/api/conversations/:id/group",auth,(req,res)=>{
 const c=one("SELECT * FROM conversations WHERE id=? AND is_group=1",[req.params.id]);
 if(!c||!isMember(c.id,req.user.id))return res.status(404).json({message:"Group not found."});
 if(c.group_admin!==req.user.id)return res.status(403).json({message:"Only the group admin can rename this group."});
 const name=String(req.body.name||"").trim();if(name.length<2||name.length>60)return res.status(400).json({message:"Group name must be 2–60 characters."});
 db.run("UPDATE conversations SET name=?,updated_at=? WHERE id=?",[name,new Date().toISOString(),c.id]);saveDB();
 const updated=conversationView(one("SELECT * FROM conversations WHERE id=?",[c.id]),req.user.id);
 rows("SELECT user_id FROM participants WHERE conversation_id=?",[c.id]).forEach(p=>io.to(`user:${p.user_id}`).emit("conversation:updated",{conversationId:c.id}));
 res.json({conversation:updated});
});
app.post("/api/conversations/:id/members",auth,(req,res)=>{
 const c=one("SELECT * FROM conversations WHERE id=? AND is_group=1",[req.params.id]),target=String(req.body.userId||"");
 if(!c||!isMember(c.id,req.user.id))return res.status(404).json({message:"Group not found."});
 if(c.group_admin!==req.user.id)return res.status(403).json({message:"Only the group admin can add members."});
 if(!one("SELECT id FROM users WHERE id=?",[target]))return res.status(400).json({message:"Choose a valid account."});
 if(isMember(c.id,target))return res.status(409).json({message:"This person is already in the group."});
 db.run("INSERT INTO participants(conversation_id,user_id) VALUES(?,?)",[c.id,target]);db.run("UPDATE conversations SET updated_at=? WHERE id=?",[new Date().toISOString(),c.id]);saveDB();
 const ids=rows("SELECT user_id FROM participants WHERE conversation_id=?",[c.id]).map(x=>x.user_id);
 ids.forEach(memberId=>io.to(`user:${memberId}`).emit("conversation:new",{memberIds:ids,conversation:conversationView(one("SELECT * FROM conversations WHERE id=?",[c.id]),memberId)}));
 res.json({success:true});
});
app.delete("/api/conversations/:id/members/:userId",auth,(req,res)=>{
 const c=one("SELECT * FROM conversations WHERE id=? AND is_group=1",[req.params.id]),target=req.params.userId;
 if(!c||!isMember(c.id,req.user.id))return res.status(404).json({message:"Group not found."});
 if(c.group_admin!==req.user.id)return res.status(403).json({message:"Only the group admin can remove members."});
 if(target===c.group_admin)return res.status(400).json({message:"The group admin cannot be removed. Transfer admin rights first."});
 if(!isMember(c.id,target))return res.status(404).json({message:"Member not found."});
 db.run("DELETE FROM participants WHERE conversation_id=? AND user_id=?",[c.id,target]);saveDB();
 io.to(`user:${target}`).emit("conversation:removed",{conversationId:c.id});
 rows("SELECT user_id FROM participants WHERE conversation_id=?",[c.id]).forEach(p=>io.to(`user:${p.user_id}`).emit("conversation:updated",{conversationId:c.id}));
 res.json({success:true});
});
app.get("/api/messages/:conversationId",auth,(req,res)=>{
 const id=req.params.conversationId;
 if(!isMember(id,req.user.id)) return res.status(403).json({message:"You are not a member of this conversation."});
 const messages=lastVisible(id,req.user.id,500).reverse().map(messageView);
 db.run("UPDATE messages SET is_delivered=1,is_read=1 WHERE conversation_id=? AND sender_id<>?",[id,req.user.id]); saveDB();
 res.json({messages});
});
app.post("/api/messages",auth,(req,res)=>{
 const conversationId=String(req.body.conversationId||""), content=String(req.body.content||"").trim();
 if(!isMember(conversationId,req.user.id)) return res.status(403).json({message:"Conversation access denied."});
 if(!content||content.length>5000) return res.status(400).json({message:"Message must contain 1–5000 characters."});
 const id=uid(), now=new Date().toISOString(), replyTo=String(req.body.replyTo||"");
 if(replyTo&&!one("SELECT id FROM messages WHERE id=? AND conversation_id=?",[replyTo,conversationId]))return res.status(400).json({message:"The message you are replying to no longer exists."});
 db.run("INSERT INTO messages(id,conversation_id,sender_id,content,type,reply_to,created_at) VALUES(?,?,?,?,?,?,?)",[id,conversationId,req.user.id,content,"text",replyTo||null,now]);
 db.run("UPDATE conversations SET updated_at=? WHERE id=?",[now,conversationId]); saveDB();
 const msg=messageView(one("SELECT * FROM messages WHERE id=?",[id]));
 io.to(`conversation:${conversationId}`).emit("message:new",msg);
 rows("SELECT user_id FROM participants WHERE conversation_id=?",[conversationId]).forEach(p=>io.to(`user:${p.user_id}`).emit("conversation:activity",{conversationId}));
 rows("SELECT user_id,subscription FROM push_subscriptions WHERE user_id IN (SELECT user_id FROM participants WHERE conversation_id=?) AND user_id<>?",[conversationId,req.user.id]).forEach(p=>{try{webpush.sendNotification(JSON.parse(p.subscription),JSON.stringify({title:"New ConnectHub message",body:content.slice(0,120),url:"/"})).catch(()=>{});}catch{}});
 res.status(201).json({message:msg});
});
app.post("/api/messages/upload",auth,upload.single("file"),(req,res)=>{
 if(!req.file) return res.status(400).json({message:"Choose a file first."});
 const conversationId=String(req.body.conversationId||"");
 if(!isMember(conversationId,req.user.id)){fs.unlinkSync(req.file.path);return res.status(403).json({message:"Conversation access denied."});}
 const id=uid(), now=new Date().toISOString(), type=req.file.mimetype.startsWith("image/")?"image":"file";
 db.run(`INSERT INTO messages(id,conversation_id,sender_id,content,type,file_name,file_url,file_size,mime_type,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,?)`,[id,conversationId,req.user.id,"",type,req.file.originalname,`/uploads/${req.file.filename}`,req.file.size,req.file.mimetype,now]);
 db.run("UPDATE conversations SET updated_at=? WHERE id=?",[now,conversationId]); saveDB();
 const msg=messageView(one("SELECT * FROM messages WHERE id=?",[id]));
 io.to(`conversation:${conversationId}`).emit("message:new",msg);
 rows("SELECT user_id FROM participants WHERE conversation_id=?",[conversationId]).forEach(p=>io.to(`user:${p.user_id}`).emit("conversation:activity",{conversationId}));
 res.status(201).json({message:msg});
});
app.put("/api/messages/:id",auth,(req,res)=>{
 const m=one("SELECT * FROM messages WHERE id=?",[req.params.id]);
 if(!m||m.sender_id!==req.user.id||m.is_deleted) return res.status(404).json({message:"Message not found."});
 const content=String(req.body.content||"").trim(); if(!content||content.length>5000) return res.status(400).json({message:"Message must contain 1–5000 characters."});
 db.run("UPDATE messages SET content=?,is_edited=1,edited_at=? WHERE id=?",[content,new Date().toISOString(),m.id]); saveDB();
 const updated=messageView(one("SELECT * FROM messages WHERE id=?",[m.id])); io.to(`conversation:${m.conversation_id}`).emit("message:update",updated);
 rows("SELECT user_id FROM participants WHERE conversation_id=?",[m.conversation_id]).forEach(p=>io.to(`user:${p.user_id}`).emit("conversation:activity",{conversationId:m.conversation_id}));
 res.json({message:updated});
});
app.delete("/api/messages/:id",auth,(req,res)=>{
 const m=one("SELECT * FROM messages WHERE id=?",[req.params.id]);
 if(!m||!isMember(m.conversation_id,req.user.id)) return res.status(404).json({message:"Message not found."});
 const scope=req.query.scope==="me"?"me":"everyone";
 if(scope==="me"){
  db.run("INSERT OR IGNORE INTO hidden_messages(message_id,user_id) VALUES(?,?)",[m.id,req.user.id]); saveDB();
  io.to(`user:${req.user.id}`).emit("message:hide",{id:m.id,conversationId:m.conversation_id});
  io.to(`user:${req.user.id}`).emit("conversation:activity",{conversationId:m.conversation_id});
  return res.json({success:true,id:m.id,scope:"me"});
 }
 if(m.sender_id!==req.user.id) return res.status(403).json({message:"You can delete for everyone only your own messages."});
 removeUploadedFile(m.file_url);
 db.run("UPDATE messages SET is_deleted=1,content='',file_url='' WHERE id=?",[m.id]); saveDB();
 const updated=messageView(one("SELECT * FROM messages WHERE id=?",[m.id]));
 rows("SELECT user_id FROM participants WHERE conversation_id=?",[m.conversation_id]).forEach(p=>{
  io.to(`user:${p.user_id}`).emit("message:update",updated);
  io.to(`user:${p.user_id}`).emit("conversation:activity",{conversationId:m.conversation_id});
 });
 res.json({message:updated,scope:"everyone"});
});
app.delete("/api/conversations/:id/messages",auth,(req,res)=>{
 const id=req.params.id; if(!isMember(id,req.user.id)) return res.status(403).json({message:"Conversation access denied."});
 if(req.query.scope==="me"){
  db.run("UPDATE participants SET cleared_at=? WHERE conversation_id=? AND user_id=?",[new Date().toISOString(),id,req.user.id]); saveDB();
  io.to(`user:${req.user.id}`).emit("conversation:cleared",{conversationId:id});
  io.to(`user:${req.user.id}`).emit("conversation:activity",{conversationId:id});
  return res.json({success:true,scope:"me"});
 }
 rows("SELECT file_url FROM messages WHERE conversation_id=? AND file_url<>''",[id]).forEach(f=>removeUploadedFile(f.file_url));
 db.run("DELETE FROM messages WHERE conversation_id=?",[id]);
 db.run("DELETE FROM hidden_messages WHERE message_id NOT IN (SELECT id FROM messages)");
 saveDB();
 rows("SELECT user_id FROM participants WHERE conversation_id=?",[id]).forEach(p=>{
  io.to(`user:${p.user_id}`).emit("conversation:cleared",{conversationId:id});
  io.to(`user:${p.user_id}`).emit("conversation:activity",{conversationId:id});
 });
 res.json({success:true,scope:"everyone"});
});
app.put("/api/messages/conversation/:id/read",auth,(req,res)=>{
 const id=req.params.id; if(!isMember(id,req.user.id)) return res.status(403).json({message:"Conversation access denied."});
 db.run("UPDATE messages SET is_delivered=1,is_read=1 WHERE conversation_id=? AND sender_id<>?",[id,req.user.id]); saveDB();
 io.to(`conversation:${id}`).emit("messages:read",{conversationId:id,readerId:req.user.id}); res.json({success:true});
});

const server=http.createServer(app);
const io=new Server(server,{cors:{origin:allowedOrigins,methods:["GET","POST"],credentials:true}});
const online=new Map(); // userId -> Set(socketId), supporting simultaneous desktop and mobile sessions
io.use((socket,next)=>{
 try { const token=socket.handshake.auth?.token; socket.user=jwt.verify(token,JWT_SECRET); if(socket.user.deviceId&&!one("SELECT id FROM devices WHERE id=? AND user_id=? AND revoked_at IS NULL",[socket.user.deviceId,socket.user.id])) return next(new Error("Device revoked")); if(!one("SELECT id FROM users WHERE id=?",[socket.user.id])) return next(new Error("Unauthorized")); next(); }
 catch { next(new Error("Unauthorized")); }
});
io.on("connection",socket=>{
 const userId=socket.user.id, sessions=online.get(userId)||new Set(), wasOnline=sessions.size>0;
 sessions.add(socket.id);online.set(userId,sessions);
 db.run("UPDATE users SET status='online',last_seen=NULL WHERE id=?",[userId]);
 socket.join(`user:${userId}`);
 if(!wasOnline)io.emit("presence:update",{userId,status:"online"});
 socket.on("conversation:join",id=>{if(isMember(id,userId)) socket.join(`conversation:${id}`);});
 socket.on("conversation:leave",id=>socket.leave(`conversation:${id}`));
 socket.on("message:delivered",({messageId})=>{
  const m=one("SELECT * FROM messages WHERE id=?",[String(messageId||"")]);
  if(!m||m.sender_id===userId||!isMember(m.conversation_id,userId))return;
  db.run("UPDATE messages SET is_delivered=1 WHERE id=?",[m.id]);saveDB();
  io.to(`user:${m.sender_id}`).emit("message:receipt",{messageId:m.id,conversationId:m.conversation_id,delivered:true});
 });
 socket.on("typing:start",({conversationId})=>{if(isMember(conversationId,userId)) socket.to(`conversation:${conversationId}`).emit("typing:update",{conversationId,userId,typing:true});});
 socket.on("typing:stop",({conversationId})=>{if(isMember(conversationId,userId)) socket.to(`conversation:${conversationId}`).emit("typing:update",{conversationId,userId,typing:false});});
 for(const event of ["call:offer","call:answer","call:ice","call:reject","call:end","call:busy"]){
  socket.on(event,payload=>{
   const targetId=String(payload?.targetUserId||"");
   if (!targetId || targetId===userId) return;
   if (["call:offer","call:answer","call:ice","call:reject","call:end","call:busy"].includes(event)) {
    // Signalling is only allowed between members of an existing one-to-one conversation.
    const validPeer = rows(`SELECT c.id FROM conversations c
      JOIN participants a ON a.conversation_id=c.id AND a.user_id=?
      JOIN participants b ON b.conversation_id=c.id AND b.user_id=?
      WHERE c.is_group=0 LIMIT 1`,[userId,targetId]).length > 0;
    if (!validPeer) return;
   }
   const target=online.get(targetId); if(target?.size){const sender=one("SELECT name FROM users WHERE id=?",[userId]);io.to(`user:${targetId}`).emit(event,{...payload,fromUserId:userId,...(event==="call:offer"?{fromName:sender?.name||"ConnectHub user"}:{})});}else if(event==="call:offer"){socket.emit("call:offline",{targetUserId:payload?.targetUserId});}});
 }
 socket.on("disconnect",()=>{
  const sessions=online.get(userId);
  if(sessions){sessions.delete(socket.id);if(sessions.size){online.set(userId,sessions);return;}online.delete(userId);}
  const seen=new Date().toISOString();db.run("UPDATE users SET status='offline',last_seen=? WHERE id=?",[seen,userId]);saveDB();io.emit("presence:update",{userId,status:"offline",lastSeen:seen});
 });
});
if (process.env.NODE_ENV === "production" && fs.existsSync(CLIENT_DIST)) {
  app.get("*", (req,res,next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/uploads/") || req.path.startsWith("/socket.io/")) return next();
    res.sendFile(path.join(CLIENT_DIST,"index.html"));
  });
}
app.use((err,_req,res,_next)=>{
 console.error(err); const status=err.code==="LIMIT_FILE_SIZE"?413:400;
 res.status(status).json({message:err.message||"Something went wrong."});
});
server.listen(PORT,"0.0.0.0",()=>console.log(`ConnectHub API running at http://localhost:${PORT}`));
