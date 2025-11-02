import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    // Check for duplicate paths in photos
    const [photoDupes] = await conn.query(`
      SELECT path, COUNT(*) as count
      FROM scanned_files sf
      JOIN photo_metadata pm ON sf.id = pm.file_id
      GROUP BY path
      HAVING count > 1
      ORDER BY count DESC
      LIMIT 5
    `);

    console.log('Duplicate photo paths:');
    photoDupes.forEach(row => console.log(`${row.path}: ${row.count} times`));

    // Check for duplicate paths in music
    const [musicDupes] = await conn.query(`
      SELECT path, COUNT(*) as count
      FROM scanned_files sf
      JOIN music_metadata mm ON sf.id = mm.file_id
      GROUP BY path
      HAVING count > 1
      ORDER BY count DESC
      LIMIT 5
    `);

    console.log('\nDuplicate music paths:');
    musicDupes.forEach(row => console.log(`${row.path}: ${row.count} times`));

    // Check for duplicate paths in videos
    const [videoDupes] = await conn.query(`
      SELECT path, COUNT(*) as count
      FROM scanned_files sf
      JOIN video_metadata vm ON sf.id = vm.file_id
      GROUP BY path
      HAVING count > 1
      ORDER BY count DESC
      LIMIT 5
    `);

    console.log('\nDuplicate video paths:');
    videoDupes.forEach(row => console.log(`${row.path}: ${row.count} times`));

    await conn.end();
  } catch (err) {
    console.error(err);
  }
})();