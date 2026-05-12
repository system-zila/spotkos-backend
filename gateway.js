require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); // Opsional, jika dibutuhkan
    next();
});

app.use(cors({ 
    origin: ['https://spotkos.vercel.app', 'http://localhost:5173'], 
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Berikan akses langsung ke folder foto/gambar agar tidak error 404
app.use('/uploads', express.static('uploads'));

// Buat mesin proxy HANYA SEKALI di awal
const userServiceProxy = createProxyMiddleware({ target: 'http://localhost:5001', changeOrigin: true });
const roomServiceProxy = createProxyMiddleware({ target: 'http://localhost:5002', changeOrigin: true });
const txServiceProxy = createProxyMiddleware({ target: 'http://localhost:5003', changeOrigin: true });
const commServiceProxy = createProxyMiddleware({ target: 'http://localhost:5004', changeOrigin: true, ws: true });

// LOGIKA BYPASS ANTI-POTONG URL & TRANSLATOR
app.use((req, res, next) => {
    // TRANSLATOR OTOMATIS
    if (req.url.includes('/api/chats/inbox')) {
        req.url = req.url.replace('/inbox', '/kotak-masuk');
    }

    const url = req.url;

    // 1. Ke User Service (Port 5001)
    if (url.startsWith('/api/login') || url.startsWith('/api/register') || url.startsWith('/api/google-login') || url.startsWith('/api/users') || url.startsWith('/api/admin/login') || url.startsWith('/api/admin/verifications')) {
        return userServiceProxy(req, res, next);
    }

    // 2. Ke Room Service (Port 5002)
    if (url.startsWith('/api/rooms') || url.startsWith('/api/articles')) {
        return roomServiceProxy(req, res, next);
    }

    // 3. Ke Transaction Service (Port 5003)
    if (url.startsWith('/api/payment') || url.startsWith('/api/bookings') || url.startsWith('/api/withdrawals') || url.startsWith('/api/admin/transactions')) {
        return txServiceProxy(req, res, next);
    }

    // 4. Ke Communication Service (Port 5004) - PASTIKAN /api/tickets ADA DI SINI
    if (url.startsWith('/api/chats') || url.startsWith('/api/support') || url.startsWith('/api/tickets') || url.startsWith('/api/admin/support') || url.startsWith('/socket.io')) {
        return commServiceProxy(req, res, next);
    }

    // Jika rute tidak ada yang cocok sama sekali
    next();
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ API Gateway berjalan di Port ${PORT}`));