import mysql from 'mysql2/promise';

async function countMusicFiles() {
    const db = await mysql.createConnection({
        host: '127.0.0.1',
        port: 3306,
        user: 'sfs',
        password: 'SilverFS_Secure2025!',
        database: 'silverfilesystem'
    });

    try {
        const [rows] = await db.execute(`
            SELECT COUNT(*) as total 
            FROM scanned_files 
            WHERE extension IN ('mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'wma')
        `);
        
        console.log('Total music files in database:', rows[0].total);
        console.log('Files processed so far: 1000');
        console.log('Remaining files:', rows[0].total - 1000);
        
    } finally {
        await db.end();
    }
}

countMusicFiles().catch(console.error);