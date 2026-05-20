require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http'); // Tambahkan ini
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: Origin tidak diizinkan: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use('/uploads', createProxyMiddleware({ target: 'http://localhost:5001', changeOrigin: true }));

const userServiceProxy = createProxyMiddleware({ target: 'http://localhost:5001', changeOrigin: true });
const roomServiceProxy = createProxyMiddleware({ target: 'http://localhost:5002', changeOrigin: true });
const txServiceProxy = createProxyMiddleware({ target: 'http://localhost:5003', changeOrigin: true });
const commServiceProxy = createProxyMiddleware({ target: 'http://localhost:5004', changeOrigin: true, ws: true });

app.use((req, res, next) => {
    if (req.url.includes('/api/chats/inbox')) req.url = req.url.replace('/inbox', '/kotak-masuk');
    const url = req.url;

    if (url.startsWith('/api/login') || url.startsWith('/api/register') || url.startsWith('/api/google-login') || url.startsWith('/api/users') || url.startsWith('/api/admin/login') || url.startsWith('/api/admin/verifications')) return userServiceProxy(req, res, next);
    if (url.startsWith('/api/rooms') || url.startsWith('/api/articles')) return roomServiceProxy(req, res, next);
    if (url.startsWith('/api/payment') || url.startsWith('/api/bookings') || url.startsWith('/api/withdrawals') || url.startsWith('/api/admin/withdrawals') || url.startsWith('/api/admin/transactions')) return txServiceProxy(req, res, next);
    if (url.startsWith('/api/chats') || url.startsWith('/api/support') || url.startsWith('/api/tickets') || url.startsWith('/api/admin/support')) return commServiceProxy(req, res, next);
    next();
});

// Bug #14: Fallback 404
app.use((req, res) => res.status(404).json({ error: 'Endpoint gateway tidak ditemukan' }));

// Bug #2: HTTP Server eksplisit untuk upgrade WS
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/socket.io') || req.url.startsWith('/api/chats')) {
        commServiceProxy.upgrade(req, socket, head);
    }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Gateway running on port ${PORT}`));