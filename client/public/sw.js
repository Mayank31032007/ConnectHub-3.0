const CACHE="connecthub-shell-v3";
const SHELL=["/","/offline.html","/manifest.webmanifest","/icons/icon-192.svg","/icons/icon-512.svg","/icons/icon-180.png","/icons/icon-192.png","/icons/icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));self.skipWaiting();});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener("fetch",e=>{
 const u=new URL(e.request.url);
 if(e.request.method!=="GET"||u.origin!==location.origin||u.pathname.startsWith("/api/")||u.pathname.startsWith("/socket.io/")||u.pathname.startsWith("/uploads/"))return;
 if(e.request.mode==="navigate"){e.respondWith(fetch(e.request).catch(()=>caches.match("/offline.html")));return;}
 e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}return r;})));
});
self.addEventListener("push",e=>{let data={title:"ConnectHub",body:"You have a new update.",url:"/"};try{data={...data,...e.data.json()};}catch{}e.waitUntil(self.registration.showNotification(data.title,{body:data.body,icon:"/icons/icon-192.svg",badge:"/icons/icon-192.svg",data:{url:data.url||"/"},tag:"connecthub-update"}));});
self.addEventListener("notificationclick",e=>{e.notification.close();const target=new URL(e.notification.data?.url||"/",self.location.origin).href;e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{for(const c of list){if(c.url.startsWith(self.location.origin)&&"focus"in c){c.navigate(target);return c.focus();}}return clients.openWindow(target);}));});
