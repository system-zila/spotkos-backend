require('dotenv').config();
const mysql = require('mysql2/promise');

/**
 * Buat pool koneksi database yang sudah dikonfigurasi dengan baik.
 * Import file ini di setiap service, JANGAN buat pool baru di masing-masing service.
 */
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT,

  // ✅ FIX 1: Tambahkan SSL untuk TiDB Cloud
  ssl: {
    rejectUnauthorized: true,
    // ca: require('fs').readFileSync(__dirname + '/tidb-ca.pem') // Un-comment setelah download .pem dari TiDB
  },

  // ✅ FIX 2: Konfigurasi pool agar tidak ETIMEDOUT
  waitForConnections: true,       // Tunggu koneksi tersedia, jangan langsung error
  connectionLimit: 10,            // Maksimal 10 koneksi sekaligus
  queueLimit: 0,                  // Antrian tidak terbatas
  connectTimeout: 30000,          // Timeout koneksi: 30 detik
  idleTimeout: 60000,             // Tutup koneksi idle setelah 60 detik
  enableKeepAlive: true,          // Kirim keep-alive agar koneksi tidak diputus cloud
  keepAliveInitialDelay: 10000,   // Mulai keep-alive setelah 10 detik idle
});

// ✅ FIX 3: Ping database saat startup untuk validasi koneksi lebih awal
db.getConnection()
  .then(conn => {
    console.log('✅ Koneksi database berhasil.');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Gagal koneksi ke database:', err.message);
    console.error('Pastikan DB_HOST, DB_USERNAME, DB_PASSWORD, DB_DATABASE, DB_PORT sudah benar di file .env');
  });

module.exports = db;
