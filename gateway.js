require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// ✅ FIX BUG #3: Header COOP yang benar agar Google OAuth tidak diblokir
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});

// ✅ FIX CORS UTAMA: Buka akses untuk semua origin secara dinamis di level gateway
app.use(cors({
  origin: true, 
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
}));

// ✅ FIX NGROK: Middleware untuk bypass ngrok browser warning di semua request
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// Akses langsung ke folder foto/gambar
app.use('/uploads', express.static('uploads'));

// ✅ FUNGSI INJEKSI CORS UNTUK PROXY
// Memastikan header CORS tetap menempel saat response kembali dari microservice
const injectCors = (proxyRes, req, res) => {
  const origin = req.headers.origin || '*';
  proxyRes.headers['Access-Control-Allow-Origin'] = origin;
  proxyRes.headers['Access-Control-Allow-Credentials'] = 'true';
  proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  proxyRes.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, ngrok-skip-browser-warning';
};

// Buat mesin proxy HANYA SEKALI di awal
const userServiceProxy = createProxyMiddleware({
  target: 'http://localhost:5001',
  changeOrigin: true,
  on: {
    proxyRes: injectCors,
    error: (err, req, res) => {
      console.error('User Service Proxy Error:', err.message);
      res.status(502).json({ error: 'User service tidak tersedia.' });
    }
  }
});

const roomServiceProxy = createProxyMiddleware({
  target: 'http://localhost:5002',
  changeOrigin: true,
  on: {
    proxyRes: injectCors,
    error: (err, req, res) => {
      console.error('Room Service Proxy Error:', err.message);
      res.status(502).json({ error: 'Room service tidak tersedia.' });
    }
  }
});

const txServiceProxy = createProxyMiddleware({
  target: 'http://localhost:5003',
  changeOrigin: true,
  on: {
    proxyRes: injectCors,
    error: (err, req, res) => {
      console.error('Transaction Service Proxy Error:', err.message);
      res.status(502).json({ error: 'Transaction service tidak tersedia.' });
    }
  }
});

// ws: true agar http-proxy-middleware bisa upgrade koneksi ke WebSocket
const commServiceProxy = createProxyMiddleware({
  target: 'http://localhost:5004',
  changeOrigin: true,
  ws: true,
  on: {
    proxyRes: injectCors,
    error: (err, req, res) => {
      console.error('Communication Service Proxy Error:', err.message);
      if (res && typeof res.status === 'function') {
        res.status(502).json({ error: 'Communication service tidak tersedia.' });
      }
    }
  }
});

// TRANSLATOR & ROUTER UTAMA
app.use((req, res, next) => {
  // Translator otomatis: /inbox -> /kotak-masuk
  if (req.url.includes('/api/chats/inbox')) {
    req.url = req.url.replace('/inbox', '/kotak-masuk');
  }

  const url = req.url;

  // 1. User Service (Port 5001)
  if (
    url.startsWith('/api/users/change-pin') ||
    url.startsWith('/api/login') ||
    url.startsWith('/api/register') ||
    url.startsWith('/api/google-login') ||
    url.startsWith('/api/users') ||
    url.startsWith('/api/admin/login') ||
    url.startsWith('/api/admin/verifications')
  ) {
    return userServiceProxy(req, res, next);
  }

  // 2. Room Service (Port 5002)
  if (url.startsWith('/api/rooms') || url.startsWith('/api/articles')) {
    return roomServiceProxy(req, res, next);
  }

  // 3. Transaction Service (Port 5003)
  if (
    url.startsWith('/api/promos') ||
    url.startsWith('/api/installments') ||
    url.startsWith('/api/pay-kos') ||
    url.startsWith('/api/transfer') ||
    url.startsWith('/api/topup') ||
    url.startsWith('/api/topup') ||
    url.startsWith('/api/payment') ||
    url.startsWith('/api/bookings') ||
    url.startsWith('/api/withdrawals') ||
    url.startsWith('/api/admin/withdrawals') ||
    url.startsWith('/api/admin/transactions')
  ) {
    return txServiceProxy(req, res, next);
  }

  // 4. Communication Service (Port 5004) - termasuk Socket.io
  if (
    url.startsWith('/api/chats') ||
    url.startsWith('/api/support') ||
    url.startsWith('/api/tickets') ||
    url.startsWith('/api/admin/support') ||
    url.startsWith('/socket.io')
  ) {
    return commServiceProxy(req, res, next);
  }

  next();
});

// Fallback 404
app.use((req, res) => {
  res.status(404).json({ error: `Endpoint tidak ditemukan: ${req.method} ${req.url}` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Gateway Error:', err.message);
  if (err.message && err.message.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  res.status(500).json({ error: 'Terjadi kesalahan di server gateway.' });
});

// Buat HTTP server eksplisit agar WebSocket upgrade bisa di-handle
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/socket.io')) {
    commServiceProxy.upgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ API Gateway berjalan di Port ${PORT}`));