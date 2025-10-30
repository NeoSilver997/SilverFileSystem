import mysql from 'mysql2/promise';

/**
 * Database Manager for storing scanned file information
 */
export class DatabaseManager {
  constructor(config = {}) {
    this.config = {
      host: config.host || process.env.DB_HOST || 'localhost',
      port: config.port || process.env.DB_PORT || 3306,
      user: config.user || process.env.DB_USER || 'root',
      password: config.password || process.env.DB_PASSWORD || '',
      database: config.database || process.env.DB_NAME || 'silverfilesystem',
      ...config
    };
    this.connection = null;
  }

  /**
   * Connect to the MySQL database
   */
  async connect() {
    try {
      this.connection = await mysql.createConnection(this.config);
      console.log('Connected to MySQL database');
    } catch (err) {
      throw new Error(`Failed to connect to database: ${err.message}`);
    }
  }

  /**
   * Create the necessary database tables
   */
  async initializeTables() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      // Create scanned_files table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS scanned_files (
          id INT AUTO_INCREMENT PRIMARY KEY,
          path VARCHAR(2048) NOT NULL,
          name VARCHAR(512) NOT NULL,
          size BIGINT NOT NULL,
          hash VARCHAR(64),
          quick_hash VARCHAR(64),
          extension VARCHAR(50),
          mtime DATETIME,
          atime DATETIME,
          ctime DATETIME,
          scan_id INT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_path (path(255)),
          INDEX idx_size (size),
          INDEX idx_hash (hash),
          INDEX idx_quick_hash (quick_hash),
          INDEX idx_extension (extension),
          INDEX idx_scan_id (scan_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      // Create scan_sessions table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS scan_sessions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          scan_path VARCHAR(2048) NOT NULL,
          total_files INT DEFAULT 0,
          total_size BIGINT DEFAULT 0,
          start_time DATETIME,
          end_time DATETIME,
          status VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_scan_path (scan_path(255)),
          INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      // Create duplicates table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS duplicate_groups (
          id INT AUTO_INCREMENT PRIMARY KEY,
          hash VARCHAR(64) NOT NULL,
          file_count INT NOT NULL,
          file_size BIGINT NOT NULL,
          wasted_space BIGINT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_hash (hash)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      console.log('Database tables initialized successfully');
    } catch (err) {
      throw new Error(`Failed to initialize tables: ${err.message}`);
    }
  }

  /**
   * Create a new scan session
   */
  async createScanSession(scanPath) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [result] = await this.connection.execute(
      'INSERT INTO scan_sessions (scan_path, start_time, status) VALUES (?, NOW(), ?)',
      [scanPath, 'running']
    );

    return result.insertId;
  }

  /**
   * Update scan session when complete
   */
  async completeScanSession(scanId, totalFiles, totalSize) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    await this.connection.execute(
      'UPDATE scan_sessions SET end_time = NOW(), status = ?, total_files = ?, total_size = ? WHERE id = ?',
      ['completed', totalFiles, totalSize, scanId]
    );
  }

  /**
   * Store a scanned file
   */
  async storeFile(file, scanId = null) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const extension = file.name.match(/\.([^.]+)$/)?.[1] || '';
    
    const [result] = await this.connection.execute(
      `INSERT INTO scanned_files 
       (path, name, size, hash, quick_hash, extension, mtime, atime, ctime, scan_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        file.path,
        file.name,
        file.size,
        file.hash || null,
        file.quickHash || null,
        extension,
        file.mtime,
        file.atime,
        file.ctime,
        scanId
      ]
    );

    return result.insertId;
  }

  /**
   * Store multiple files in batch
   */
  async storeFilesBatch(files, scanId = null) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    if (files.length === 0) {
      return;
    }

    const values = files.map(file => {
      const extension = file.name.match(/\.([^.]+)$/)?.[1] || '';
      return [
        file.path,
        file.name,
        file.size,
        file.hash || null,
        file.quickHash || null,
        extension,
        file.mtime,
        file.atime,
        file.ctime,
        scanId
      ];
    });

    const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const flatValues = values.flat();

    await this.connection.execute(
      `INSERT INTO scanned_files 
       (path, name, size, hash, quick_hash, extension, mtime, atime, ctime, scan_id)
       VALUES ${placeholders}`,
      flatValues
    );
  }

  /**
   * Store duplicate group information
   */
  async storeDuplicateGroup(hash, fileCount, fileSize) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const wastedSpace = (fileCount - 1) * fileSize;

    await this.connection.execute(
      'INSERT INTO duplicate_groups (hash, file_count, file_size, wasted_space) VALUES (?, ?, ?, ?)',
      [hash, fileCount, fileSize, wastedSpace]
    );
  }

  /**
   * Query files by various criteria
   */
  async queryFiles(criteria = {}) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    let query = 'SELECT * FROM scanned_files WHERE 1=1';
    const params = [];

    if (criteria.minSize) {
      query += ' AND size >= ?';
      params.push(criteria.minSize);
    }

    if (criteria.maxSize) {
      query += ' AND size <= ?';
      params.push(criteria.maxSize);
    }

    if (criteria.extension) {
      query += ' AND extension = ?';
      params.push(criteria.extension);
    }

    if (criteria.scanId) {
      query += ' AND scan_id = ?';
      params.push(criteria.scanId);
    }

    if (criteria.limit) {
      query += ' LIMIT ?';
      params.push(criteria.limit);
    }

    const [rows] = await this.connection.execute(query, params);
    return rows;
  }

  /**
   * Get duplicate files from database
   */
  async getDuplicates(minSize = 0) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      `SELECT hash, COUNT(*) as count, size, GROUP_CONCAT(path SEPARATOR '|||') as paths
       FROM scanned_files
       WHERE hash IS NOT NULL AND size >= ?
       GROUP BY hash, size
       HAVING count > 1
       ORDER BY size DESC`,
      [minSize]
    );

    return rows.map(row => ({
      hash: row.hash,
      count: row.count,
      size: row.size,
      paths: row.paths.split('|||')
    }));
  }

  /**
   * Get statistics from database
   */
  async getStatistics(scanId = null) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    let query = 'SELECT COUNT(*) as total_files, SUM(size) as total_size FROM scanned_files';
    const params = [];

    if (scanId) {
      query += ' WHERE scan_id = ?';
      params.push(scanId);
    }

    const [rows] = await this.connection.execute(query, params);
    return rows[0];
  }

  /**
   * Close the database connection
   */
  async close() {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
      console.log('Database connection closed');
    }
  }
}
