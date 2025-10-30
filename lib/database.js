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
          extension VARCHAR(255),
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

      // Create photo metadata table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS photo_metadata (
          id INT AUTO_INCREMENT PRIMARY KEY,
          file_id INT NOT NULL,
          width INT,
          height INT,
          format VARCHAR(50),
          orientation INT,
          camera_make VARCHAR(255),
          camera_model VARCHAR(255),
          lens_model VARCHAR(255),
          iso INT,
          aperture DECIMAL(5,2),
          shutter_speed VARCHAR(50),
          focal_length DECIMAL(6,2),
          flash VARCHAR(100),
          date_taken DATETIME,
          latitude DECIMAL(10,8),
          longitude DECIMAL(11,8),
          altitude DECIMAL(10,2),
          software VARCHAR(255),
          artist VARCHAR(255),
          copyright TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (file_id) REFERENCES scanned_files(id) ON DELETE CASCADE,
          INDEX idx_file_id (file_id),
          INDEX idx_dimensions (width, height),
          INDEX idx_camera (camera_make, camera_model),
          INDEX idx_date_taken (date_taken)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      // Create music metadata table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS music_metadata (
          id INT AUTO_INCREMENT PRIMARY KEY,
          file_id INT NOT NULL,
          title VARCHAR(512),
          artist VARCHAR(512),
          album VARCHAR(512),
          album_artist VARCHAR(512),
          year INT,
          genre VARCHAR(255),
          track_number INT,
          track_total INT,
          disk_number INT,
          disk_total INT,
          duration DECIMAL(10,2),
          bitrate INT,
          sample_rate INT,
          channels INT,
          codec VARCHAR(100),
          composer VARCHAR(512),
          isrc VARCHAR(50),
          has_album_art BOOLEAN,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (file_id) REFERENCES scanned_files(id) ON DELETE CASCADE,
          INDEX idx_file_id (file_id),
          INDEX idx_artist (artist(255)),
          INDEX idx_album (album(255)),
          INDEX idx_title (title(255)),
          INDEX idx_year (year),
          INDEX idx_genre (genre)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      // Create video metadata table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS video_metadata (
          id INT AUTO_INCREMENT PRIMARY KEY,
          file_id INT NOT NULL,
          title VARCHAR(512),
          duration DECIMAL(10,2),
          width INT,
          height INT,
          frame_rate DECIMAL(8,3),
          video_codec VARCHAR(100),
          video_bitrate INT,
          audio_codec VARCHAR(100),
          audio_bitrate INT,
          audio_sample_rate INT,
          audio_channels INT,
          description TEXT,
          genre VARCHAR(255),
          artist VARCHAR(512),
          year INT,
          create_date DATETIME,
          software VARCHAR(255),
          latitude DECIMAL(10,8),
          longitude DECIMAL(11,8),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (file_id) REFERENCES scanned_files(id) ON DELETE CASCADE,
          INDEX idx_file_id (file_id),
          INDEX idx_dimensions (width, height),
          INDEX idx_duration (duration),
          INDEX idx_title (title(255)),
          INDEX idx_artist (artist(255))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      console.log('Database tables initialized successfully');
    } catch (err) {
      throw new Error(`Failed to initialize tables: ${err.message}`);
    }
  }

  /**
   * Update database schema to latest version
   */
  async updateSchema() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      // Update extension column to support longer extensions
      await this.connection.execute(`
        ALTER TABLE scanned_files 
        MODIFY COLUMN extension VARCHAR(255)
      `);
      console.log('Database schema updated successfully');
    } catch (err) {
      // Ignore error if column already has correct size
      if (!err.message.includes('Duplicate column name') && !err.message.includes('already exists')) {
        console.warn(`Schema update warning: ${err.message}`);
      }
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
   * Extract file extension from filename
   */
  getFileExtension(filename) {
    const match = filename.match(/\.([^.]+)$/);
    let extension = match ? match[1] : '';
    
    // Limit extension length to prevent database errors
    if (extension.length > 255) {
      extension = extension.substring(0, 255);
    }
    
    return extension;
  }

  /**
   * Convert undefined values to null for database insertion
   */
  sanitizeForDb(value) {
    return value === undefined ? null : value;
  }

  /**
   * Clean numeric values that might have units attached
   */
  cleanNumericValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      // Extract number from string like "16.0 mm" or "f/2.8"
      const match = value.match(/^f?\/?([\d.-]+)/);
      if (match) {
        const num = parseFloat(match[1]);
        return isNaN(num) ? null : num;
      }
    }
    return null;
  }

  /**
   * Clean datetime values to proper MySQL datetime format
   */
  cleanDateTimeValue(value) {
    if (value === null || value === undefined) return null;
    
    // If it's already a Date object
    if (value instanceof Date) {
      return value.toISOString().slice(0, 19).replace('T', ' ');
    }
    
    // If it's an object with date components (like ExifDateTime)
    if (typeof value === 'object' && value.year) {
      try {
        const date = new Date(value.year, value.month - 1, value.day, value.hour || 0, value.minute || 0, value.second || 0);
        return date.toISOString().slice(0, 19).replace('T', ' ');
      } catch (err) {
        return null;
      }
    }
    
    // If it's a string, try to parse it
    if (typeof value === 'string') {
      try {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
          return date.toISOString().slice(0, 19).replace('T', ' ');
        }
      } catch (err) {
        return null;
      }
    }
    
    return null;
  }

  /**
   * Store a scanned file
   */
  async storeFile(file, scanId = null) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const extension = this.getFileExtension(file.name);
    
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
      const extension = this.getFileExtension(file.name);
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
   * Store photo metadata
   */
  async storePhotoMetadata(fileId, metadata) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    if (!metadata) return;

    await this.connection.execute(
      `INSERT INTO photo_metadata 
       (file_id, width, height, format, orientation, camera_make, camera_model, lens_model,
        iso, aperture, shutter_speed, focal_length, flash, date_taken, 
        latitude, longitude, altitude, software, artist, copyright)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fileId,
        this.sanitizeForDb(metadata.width),
        this.sanitizeForDb(metadata.height),
        this.sanitizeForDb(metadata.format),
        this.sanitizeForDb(metadata.orientation),
        this.sanitizeForDb(metadata.camera?.make),
        this.sanitizeForDb(metadata.camera?.model),
        this.sanitizeForDb(metadata.camera?.lens),
        this.cleanNumericValue(metadata.settings?.iso),
        this.cleanNumericValue(metadata.settings?.aperture),
        this.cleanNumericValue(metadata.settings?.shutterSpeed),
        this.cleanNumericValue(metadata.settings?.focalLength),
        this.sanitizeForDb(metadata.settings?.flash),
        this.cleanDateTimeValue(metadata.datetime?.taken),
        this.sanitizeForDb(metadata.location?.latitude),
        this.sanitizeForDb(metadata.location?.longitude),
        this.sanitizeForDb(metadata.location?.altitude),
        this.sanitizeForDb(metadata.software),
        this.sanitizeForDb(metadata.artist),
        this.sanitizeForDb(metadata.copyright)
      ]
    );
  }

  /**
   * Store music metadata
   */
  async storeMusicMetadata(fileId, metadata) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    if (!metadata) return;

    await this.connection.execute(
      `INSERT INTO music_metadata 
       (file_id, title, artist, album, album_artist, year, genre, track_number, track_total,
        disk_number, disk_total, duration, bitrate, sample_rate, channels, codec,
        composer, isrc, has_album_art)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fileId,
        this.sanitizeForDb(metadata.track?.title),
        this.sanitizeForDb(metadata.track?.artist),
        this.sanitizeForDb(metadata.track?.album),
        this.sanitizeForDb(metadata.track?.albumArtist),
        this.cleanNumericValue(metadata.track?.year),
        this.sanitizeForDb(metadata.track?.genre?.[0]), // Get first genre if array
        this.cleanNumericValue(metadata.track?.trackNumber),
        this.cleanNumericValue(metadata.track?.trackTotal),
        this.cleanNumericValue(metadata.track?.diskNumber),
        this.cleanNumericValue(metadata.track?.diskTotal),
        this.cleanNumericValue(metadata.format?.duration),
        this.cleanNumericValue(metadata.format?.bitrate),
        this.cleanNumericValue(metadata.format?.sampleRate),
        this.cleanNumericValue(metadata.format?.numberOfChannels),
        this.sanitizeForDb(metadata.format?.codec),
        this.sanitizeForDb(metadata.composer),
        this.sanitizeForDb(metadata.isrc),
        this.sanitizeForDb(metadata.hasAlbumArt)
      ]
    );
  }

  /**
   * Store video metadata
   */
  async storeVideoMetadata(fileId, metadata) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    if (!metadata) return;

    await this.connection.execute(
      `INSERT INTO video_metadata 
       (file_id, title, duration, width, height, frame_rate, video_codec, video_bitrate,
        audio_codec, audio_bitrate, audio_sample_rate, audio_channels, description,
        genre, artist, year, create_date, software, latitude, longitude)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fileId,
        this.sanitizeForDb(metadata.title),
        this.cleanNumericValue(metadata.video?.duration),
        this.cleanNumericValue(metadata.video?.width),
        this.cleanNumericValue(metadata.video?.height),
        this.cleanNumericValue(metadata.video?.frameRate),
        this.sanitizeForDb(metadata.video?.codec),
        this.cleanNumericValue(metadata.video?.bitrate),
        this.sanitizeForDb(metadata.audio?.codec),
        this.cleanNumericValue(metadata.audio?.bitrate),
        this.cleanNumericValue(metadata.audio?.sampleRate),
        this.cleanNumericValue(metadata.audio?.channels),
        this.sanitizeForDb(metadata.description),
        this.sanitizeForDb(metadata.genre),
        this.sanitizeForDb(metadata.artist),
        this.cleanNumericValue(metadata.year),
        this.cleanDateTimeValue(metadata.createDate),
        this.sanitizeForDb(metadata.software),
        this.sanitizeForDb(metadata.location?.latitude),
        this.sanitizeForDb(metadata.location?.longitude)
      ]
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
