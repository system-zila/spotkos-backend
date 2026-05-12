// PERBAIKAN 1: Wajib ada agar membaca file .env untuk koneksi ke TiDB Cloud
require('dotenv').config();
const mysql = require('mysql2/promise');

async function seedDatabase() {
  // 1. Buka Koneksi ke MySQL
  const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: {
      rejectUnauthorized: true // Wajib ditambahkan untuk TiDB Cloud
    }
  });

  console.log('Terhubung ke database. Memulai migrasi data...');

  try {
    // 2. Injeksi Data Pengguna (Admin & Owner)
    // PERBAIKAN 2: Mengubah kolom 'name' menjadi 'full_name' sesuai skema terbaru
    await db.query(`
      INSERT INTO users (full_name, email, password, role, phone) VALUES
      ('Admin SpotKos', 'admin@spotkos.com', 'admin123', 'admin', '081200000000'),
      ('Ibu Melati', 'melati@email.com', 'owner123', 'owner', '081234567890'),
      ('Pak Wayan', 'wayan@email.com', 'owner123', 'owner', '081987654321')
    `);
    console.log('✅ Data Pengguna berhasil diinput.');

    // 3. Injeksi Data Artikel (Format JSON untuk struktur kompleks)
    await db.query(`
      INSERT INTO articles (title, content, image, author_id) VALUES
      ('7 Tips Mencari Kos yang Aman dan Nyaman', '{"intro":"Mencari kos yang tepat gampang-gampang susah...","sections":[{"heading":"1. Cek Lokasi","content":"Pastikan dekat kampus..."}]}', 'https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af', 1)
    `);
    console.log('✅ Data Artikel berhasil diinput.');

    // 4. Injeksi Data Kos (Menggunakan JSON.stringify untuk array)
    const rooms = [
      {
        name: "Kost Melati Residence", location: "Menteng, Jakarta Pusat", address: "Jl. Menteng Raya No. 45", price: 2500000, rating: 4.9, reviews_count: 124, gender: "Campur", description: "Kost modern di area strategis Menteng.",
        image: "https://images.unsplash.com/photo-1703783010857-9bd7a7b97c50",
        images: JSON.stringify(["https://images.unsplash.com/photo-1703783010857-9bd7a7b97c50", "https://images.unsplash.com/photo-1540518614846-7eded433c457"]),
        facilities: JSON.stringify(["AC", "Wi-Fi", "Kamar Mandi Dalam", "Dapur"]), rules: JSON.stringify(["Tidak bawa hewan", "Jam malam 21.00"]), nearby_places: JSON.stringify(["UI - 2.5 km", "Plaza Indonesia - 1.8 km"]), availability: JSON.stringify({totalRooms: 20, availableRooms: 15}), payment_methods: JSON.stringify(["Visa", "Mastercard"]),
        room_size: "3 x 4 meter", capacity: "1 orang", bathroom_type: "Kamar mandi dalam", floor_range: "Lantai 2-4", owner_name: "Ibu Melati", owner_phone: "0812-3456-7890", owner_response_time: "Cepat (< 1 jam)"
      },
      {
        name: "Kost Permata Hijau", location: "Dago, Bandung", address: "Jl. Dago Atas No. 88", price: 1800000, rating: 4.8, reviews_count: 89, gender: "Wanita", description: "Kost khusus putri yang aman dan sejuk.",
        image: "https://images.unsplash.com/photo-1636321667799-ddf30b3e1261",
        images: JSON.stringify(["https://images.unsplash.com/photo-1636321667799-ddf30b3e1261"]),
        facilities: JSON.stringify(["AC", "Wi-Fi", "Kamar Mandi Luar"]), rules: JSON.stringify(["Khusus putri", "Jam malam 20.00"]), nearby_places: JSON.stringify(["ITB - 3 km"]), availability: JSON.stringify({totalRooms: 15, availableRooms: 10}), payment_methods: JSON.stringify(["Visa"]),
        room_size: "3 x 3 meter", capacity: "1 orang", bathroom_type: "Kamar mandi luar", floor_range: "Lantai 1-3", owner_name: "Ibu Permata", owner_phone: "0813-2345-6789", owner_response_time: "Cepat"
      }
    ];

    for (const room of rooms) {
      await db.query(`
        INSERT INTO rooms (name, location, address, price, rating, reviews_count, gender, description, image, images, facilities, rules, nearby_places, availability, payment_methods, room_size, capacity, bathroom_type, floor_range, owner_name, owner_phone, owner_response_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [room.name, room.location, room.address, room.price, room.rating, room.reviews_count, room.gender, room.description, room.image, room.images, room.facilities, room.rules, room.nearby_places, room.availability, room.payment_methods, room.room_size, room.capacity, room.bathroom_type, room.floor_range, room.owner_name, room.owner_phone, room.owner_response_time]);
    }
    console.log('✅ Data Kos berhasil diinput.');

  } catch (err) {
    console.error('❌ Gagal melakukan migrasi:', err.message);
  } finally {
    // 5. Tutup koneksi agar terminal tidak menggantung
    await db.end();
    console.log('Migrasi selesai. Koneksi ditutup.');
  }
}

seedDatabase();