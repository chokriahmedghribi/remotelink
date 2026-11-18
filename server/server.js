// خادم اختياري: يقدّم تطبيق الويب + خادم إشارة PeerJS خاص بك (بدل الخادم السحابي العام)
// التشغيل: cd server && npm install && node server.js   ثم افتح http://localhost:9000
const express = require('express');
const path = require('path');
const { ExpressPeerServer } = require('peer');

const PORT = process.env.PORT || 9000;
const app = express();
app.use(express.static(path.join(__dirname, '..', 'www')));
const server = app.listen(PORT, () => console.log(`RemoteLink: http://localhost:${PORT}  (signaling on /rl)`));
app.use('/rl', ExpressPeerServer(server, { path: '/', allow_discovery: false, proxied: !!process.env.BEHIND_PROXY }));
