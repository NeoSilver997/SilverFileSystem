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
      // Ensure the connection uses utf8mb4 to properly handle multi-byte characters
      const connConfig = Object.assign({}, this.config, { charset: 'utf8mb4' });
      this.connection = await mysql.createConnection(connConfig);
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
   * Also handles encoding issues for text that looks garbled
   */
  sanitizeForDb(value) {
    // Normalize undefined to null for DB
    if (value === undefined || value === null) return null;

    // If it's a Buffer, try utf8 first, then latin1 as a fallback
    if (Buffer.isBuffer(value)) {
      try {
        const utf8 = value.toString('utf8');
        // If valid UTF-8 (no replacement chars), return it
        if (!utf8.includes('\uFFFD')) return utf8;
      } catch (err) {
        // ignore and try latin1 below
      }

      try {
        return value.toString('latin1');
      } catch (err) {
        return value.toString('utf8');
      }
    }

    // Preserve numbers and booleans as-is so numeric DB columns remain numeric
    if (typeof value === 'number' || typeof value === 'boolean') return value;

    // If it's an array, join into a readable string
    if (Array.isArray(value)) {
      return value.map(v => (v === null || v === undefined) ? '' : String(v)).join(', ');
    }

    // If it's an object (not Buffer/Array), stringify it for storage
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch (err) {
        return String(value);
      }
    }

    // For strings, keep them as-is and let UTF8MB4 connection handle the encoding
    if (typeof value === 'string') {
      return value;
    }

    // For other primitives, ensure a string return
    return String(value);
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
   * Get files without hashes for duplicate detection
   */
  async getFilesWithoutHash(minSize = 0, maxSize = 0, limit = null) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    // Ensure minSize is a valid number
    const validMinSize = (typeof minSize === 'number' && !isNaN(minSize)) ? minSize : 0;
    
    // Default to 2GB limit if no max size specified (Node.js limitation for old method)
    const validMaxSize = (maxSize && typeof maxSize === 'number' && maxSize > 0) ? maxSize : 0;
    
    let query = `SELECT id, path, size FROM scanned_files 
                 WHERE hash IS NULL AND size >= ${validMinSize}`;
    
    if (validMaxSize > 0) {
      query += ` AND size <= ${validMaxSize}`;
    }
    
    query += ` ORDER BY size DESC`;

    if (limit && typeof limit === 'number' && limit > 0) {
      query += ` LIMIT ${limit}`;
    }

    const [rows] = await this.connection.query(query);
    return rows;
  }

  /**
   * Get files without hashes, but for large files (>200MB) only get those with duplicate sizes
   */
  async getFilesWithoutHashOptimized(minSize = 0, maxSize = 0, limit = null, largeSizeThreshold = 200 * 1024 * 1024) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    // Ensure minSize is a valid number
    const validMinSize = (typeof minSize === 'number' && !isNaN(minSize)) ? minSize : 0;
    
    // Default to 2GB limit if no max size specified
    const validMaxSize = (maxSize && typeof maxSize === 'number' && maxSize > 0) ? maxSize : 0;
    
    let query = `
      SELECT sf.id, sf.path, sf.size 
      FROM scanned_files sf
      WHERE sf.hash IS NULL AND sf.size >= ${validMinSize}
    `;
    
    // For large files, only include those that have potential duplicates (same size)
    query += `
      AND (
        sf.size < ${largeSizeThreshold} 
        OR sf.size IN (
          SELECT size 
          FROM scanned_files 
          WHERE hash IS NULL AND size >= ${largeSizeThreshold}
          GROUP BY size 
          HAVING COUNT(*) > 1
        )
      )
    `;
    
    if (validMaxSize > 0) {
      query += ` AND sf.size <= ${validMaxSize}`;
    }
    
    query += ` ORDER BY sf.size DESC`;

    if (limit && typeof limit === 'number' && limit > 0) {
      query += ` LIMIT ${limit}`;
    }

    const [rows] = await this.connection.query(query);
    return rows;
  }

  /**
   * Get files without hashes, only for files that have potential duplicates (same size)
   * This is the most efficient approach - only hash files that can actually be duplicates
   */
  async getFilesWithoutHashSmart(minSize = 0, maxSize = 0, limit = null) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    // Ensure minSize is a valid number
    const validMinSize = (typeof minSize === 'number' && !isNaN(minSize)) ? minSize : 0;
    
    // Default to unlimited if no max size specified
    const validMaxSize = (maxSize && typeof maxSize === 'number' && maxSize > 0) ? maxSize : 0;
    
    let query = `
      SELECT sf.id, sf.path, sf.size 
      FROM scanned_files sf
      WHERE sf.hash IS NULL 
        AND sf.size >= ${validMinSize}
        AND sf.size IN (
          SELECT size 
          FROM scanned_files 
          WHERE hash IS NULL AND size >= ${validMinSize}
    `;
    
    if (validMaxSize > 0) {
      query += ` AND size <= ${validMaxSize}`;
    }
    
    query += `
          GROUP BY size 
          HAVING COUNT(*) > 1
        )
    `;
    
    if (validMaxSize > 0) {
      query += ` AND sf.size <= ${validMaxSize}`;
    }
    
    query += ` ORDER BY sf.size DESC`;

    if (limit && typeof limit === 'number' && limit > 0) {
      query += ` LIMIT ${limit}`;
    }

    const [rows] = await this.connection.query(query);
    return rows;
  }

  /**
   * Update hash for a file by ID
   */
  async updateFileHash(fileId, hash, quickHash = null) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    // Escape values for safe SQL interpolation
    const escapedHash = hash ? `'${hash.replace(/'/g, "''")}'` : 'NULL';
    const escapedQuickHash = quickHash ? `'${quickHash.replace(/'/g, "''")}'` : 'NULL';
    const escapedFileId = parseInt(fileId);

    await this.connection.query(
      `UPDATE scanned_files SET hash = ${escapedHash}, quick_hash = ${escapedQuickHash} WHERE id = ${escapedFileId}`
    );
  }

  /**
   * Get count of large files that would be skipped vs processed with optimization
   */
  async getLargeFileStats(largeSizeThreshold = 200 * 1024 * 1024) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    // Count total large files without hash
    const [totalLarge] = await this.connection.query(`
      SELECT COUNT(*) as count 
      FROM scanned_files 
      WHERE hash IS NULL AND size >= ${largeSizeThreshold}
    `);

    // Count large files that have potential duplicates (would be processed)
    const [withDuplicates] = await this.connection.query(`
      SELECT COUNT(*) as count 
      FROM scanned_files sf
      WHERE sf.hash IS NULL AND sf.size >= ${largeSizeThreshold}
      AND sf.size IN (
        SELECT size 
        FROM scanned_files 
        WHERE hash IS NULL AND size >= ${largeSizeThreshold}
        GROUP BY size 
        HAVING COUNT(*) > 1
      )
    `);

    return {
      totalLargeFiles: totalLarge[0].count,
      largeFilesWithDuplicates: withDuplicates[0].count,
      largeFilesSkipped: totalLarge[0].count - withDuplicates[0].count
    };
  }

  /**
   * Get files grouped by size and name for reporting
   */
  async getFilesBySizeAndName(minSize = 0) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.query(`
      SELECT 
        name,
        size,
        COUNT(DISTINCT path) as count,
        GROUP_CONCAT(DISTINCT path SEPARATOR '|||') as paths
      FROM scanned_files 
      WHERE size >= ${minSize}
      GROUP BY name, size
      HAVING COUNT(DISTINCT path) > 1
      ORDER BY size DESC, count DESC
    `);

    return rows.map(row => ({
      name: row.name,
      size: row.size,
      count: row.count,
      paths: row.paths.split('|||')
    }));
  }

  /**
   * Get files by size only (potential duplicates)
   */
  async getFilesBySize(minSize = 0) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.query(`
      SELECT 
        size,
        COUNT(DISTINCT path) as count,
        GROUP_CONCAT(DISTINCT CONCAT(name, '|', path) SEPARATOR '|||') as files
      FROM scanned_files 
      WHERE size >= ${minSize}
      GROUP BY size
      HAVING COUNT(DISTINCT path) > 1
      ORDER BY size DESC
    `);

    return rows.map(row => ({
      size: row.size,
      count: row.count,
      files: row.files.split('|||').map(file => {
        const [name, ...pathParts] = file.split('|');
        return { name, path: pathParts.join('|') };
      })
    }));
  }

  /**
   * Get duplicate files grouped by folder for HTML reporting
   */
  async getDuplicatesByFolder(minSize = 0) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.query(`
      SELECT DISTINCT
        path,
        name,
        size,
        hash,
        COUNT(*) OVER (PARTITION BY hash) as duplicate_count
      FROM scanned_files 
      WHERE hash IS NOT NULL 
        AND size >= ${minSize}
        AND hash IN (
          SELECT hash 
          FROM scanned_files 
          WHERE hash IS NOT NULL AND size >= ${minSize}
          GROUP BY hash 
          HAVING COUNT(DISTINCT path) > 1
        )
      ORDER BY path, size DESC, name
    `);

    // Remove exact duplicates (same path and size) and group by folder
    const seenFiles = new Set();
    const uniqueFiles = rows.filter(row => {
      const key = `${row.path}-${row.size}`;
      if (seenFiles.has(key)) {
        return false; // Skip duplicate path+size combinations
      }
      seenFiles.add(key);
      return true;
    });

    // Group by folder
    const folderGroups = new Map();
    
    uniqueFiles.forEach(row => {
      // Extract folder path (directory part of the path)
      const folderPath = row.path.substring(0, row.path.lastIndexOf('\\')) || 'Root';
      
      if (!folderGroups.has(folderPath)) {
        folderGroups.set(folderPath, {
          folderPath: folderPath,
          files: [],
          totalFiles: 0,
          totalWastedSpace: 0,
          duplicateGroups: new Map()
        });
      }
      
      const folder = folderGroups.get(folderPath);
      folder.files.push(row);
      folder.totalFiles++;
      
      // Group by hash within folder
      if (!folder.duplicateGroups.has(row.hash)) {
        folder.duplicateGroups.set(row.hash, {
          hash: row.hash,
          size: row.size,
          files: [],
          count: row.duplicate_count,
          wastedSpace: (row.duplicate_count - 1) * row.size
        });
      }
      
      folder.duplicateGroups.get(row.hash).files.push(row);
    });

    // Convert to array and calculate totals
    const result = Array.from(folderGroups.values()).map(folder => {
      folder.duplicateGroups = Array.from(folder.duplicateGroups.values());
      folder.totalWastedSpace = folder.duplicateGroups.reduce((sum, group) => {
        // Only count wasted space for files in this folder
        const filesInFolder = group.files.length;
        return sum + (filesInFolder > 1 ? (filesInFolder - 1) * group.size : 0);
      }, 0);
      return folder;
    });

    return result.sort((a, b) => b.totalWastedSpace - a.totalWastedSpace);
  }

  /**
   * Get duplicates by name and size (files with same name and size in different locations)
   */
  async getDuplicatesByNameAndSize(minSize = 0) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.query(`
      SELECT 
        name,
        size,
        COUNT(DISTINCT path) as count,
        GROUP_CONCAT(DISTINCT CONCAT(path, '|||', IFNULL(mtime, '')) ORDER BY path SEPARATOR '###') as file_info
      FROM scanned_files 
      WHERE size >= ${minSize}
      GROUP BY name, size
      HAVING COUNT(DISTINCT path) > 1
      ORDER BY size DESC, count DESC, name
    `);

    return rows.map(row => ({
      name: row.name,
      size: row.size,
      count: row.count,
      wastedSpace: (row.count - 1) * row.size,
      files: row.file_info.split('###').map(info => {
        const [filePath, mtime] = info.split('|||');
        return {
          path: filePath,
          mtime: mtime || null,
          name: row.name,
          size: row.size
        };
      })
    }));
  }

  /**
   * Detect completely duplicated folders (folders with identical content)
   */
  async getCompleteDuplicateFolders(minSize = 0) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    // Get all folders with their file counts and total sizes
    const [folders] = await this.connection.query(`
      SELECT 
        SUBSTRING_INDEX(path, '/', -2) as folder_name,
        SUBSTRING_INDEX(path, '/', CHAR_LENGTH(path) - CHAR_LENGTH(SUBSTRING_INDEX(path, '/', -1))) as folder_path,
        COUNT(*) as file_count,
        SUM(size) as total_size,
        GROUP_CONCAT(CONCAT(name, '|', size, '|', IFNULL(hash, 'NULL')) ORDER BY name SEPARATOR '###') as files_signature
      FROM scanned_files
      WHERE size >= ${minSize}
        AND path LIKE '%/%'
      GROUP BY folder_path
      HAVING file_count > 0
    `);

    // Group folders by their signature (same files with same sizes)
    const signatureMap = new Map();
    
    folders.forEach(folder => {
      const signature = `${folder.file_count}|${folder.total_size}|${folder.files_signature}`;
      
      if (!signatureMap.has(signature)) {
        signatureMap.set(signature, []);
      }
      
      signatureMap.get(signature).push({
        folderPath: folder.folder_path,
        folderName: folder.folder_name,
        fileCount: folder.file_count,
        totalSize: folder.total_size
      });
    });

    // Filter to only folders with duplicates
    const duplicatedFolders = Array.from(signatureMap.values())
      .filter(group => group.length > 1)
      .map(group => ({
        folders: group,
        count: group.length,
        fileCount: group[0].fileCount,
        totalSize: group[0].totalSize,
        wastedSpace: (group.length - 1) * group[0].totalSize
      }))
      .sort((a, b) => b.wastedSpace - a.wastedSpace);

    return duplicatedFolders;
  }

  /**
   * Get statistics for smart hashing optimization (all file sizes)
   */
  async getSmartHashStats(minSize = 0, maxSize = 0) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const validMinSize = (typeof minSize === 'number' && !isNaN(minSize)) ? minSize : 0;
    const validMaxSize = (maxSize && typeof maxSize === 'number' && maxSize > 0) ? maxSize : 0;

    // Count total files without hash
    let totalQuery = `
      SELECT COUNT(*) as count 
      FROM scanned_files 
      WHERE hash IS NULL AND size >= ${validMinSize}
    `;
    if (validMaxSize > 0) {
      totalQuery += ` AND size <= ${validMaxSize}`;
    }
    const [totalFiles] = await this.connection.query(totalQuery);

    // Count files that have potential duplicates (would be processed)
    let duplicatesQuery = `
      SELECT COUNT(*) as count 
      FROM scanned_files sf
      WHERE sf.hash IS NULL AND sf.size >= ${validMinSize}
    `;
    if (validMaxSize > 0) {
      duplicatesQuery += ` AND sf.size <= ${validMaxSize}`;
    }
    duplicatesQuery += `
      AND sf.size IN (
        SELECT size 
        FROM scanned_files 
        WHERE hash IS NULL AND size >= ${validMinSize}
    `;
    if (validMaxSize > 0) {
      duplicatesQuery += ` AND size <= ${validMaxSize}`;
    }
    duplicatesQuery += `
        GROUP BY size 
        HAVING COUNT(*) > 1
      )
    `;
    const [withDuplicates] = await this.connection.query(duplicatesQuery);

    return {
      totalFiles: totalFiles[0].count,
      filesWithPotentialDuplicates: withDuplicates[0].count,
      filesSkipped: totalFiles[0].count - withDuplicates[0].count,
      percentageSkipped: totalFiles[0].count > 0 
        ? ((totalFiles[0].count - withDuplicates[0].count) / totalFiles[0].count * 100).toFixed(1)
        : 0
    };
  }

  /**
   * Get all files grouped by size (potential duplicates)
   */
  async getFilesBySizeGroups(minSize = 0) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      `SELECT size, COUNT(*) as count
       FROM scanned_files
       WHERE size >= ?
       GROUP BY size
       HAVING count > 1
       ORDER BY size DESC`,
      [minSize]
    );

    return rows;
  }

  /**
   * Get files by size
   */
  async getFilesBySize(size) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      'SELECT id, path, name, size, hash, quick_hash FROM scanned_files WHERE size = ?',
      [size]
    );

    return rows;
  }

  /**
   * Get detailed duplicate information with file paths
   */
  async getDuplicatesDetailed(minSize = 0) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [groups] = await this.connection.execute(
      `SELECT hash, COUNT(*) as count, size
       FROM scanned_files
       WHERE hash IS NOT NULL AND size >= ?
       GROUP BY hash, size
       HAVING count > 1
       ORDER BY size DESC`,
      [minSize]
    );

    const duplicateGroups = [];
    
    for (const group of groups) {
      const [files] = await this.connection.execute(
        'SELECT id, path, name, size, mtime FROM scanned_files WHERE hash = ? AND size = ?',
        [group.hash, group.size]
      );

      duplicateGroups.push({
        hash: group.hash,
        count: group.count,
        size: group.size,
        wastedSpace: (group.count - 1) * group.size,
        files: files
      });
    }

    return duplicateGroups;
  }

  /**
   * Normalize a file path for consistent storage and querying
   * @param {string} filePath - The file path to normalize
   * @returns {string} - The normalized path
   */
  normalizePath(filePath) {
    if (!filePath) return '';
    
    // Convert to forward slashes for consistency
    let normalized = filePath.replace(/\\/g, '/');
    
    // Remove drive letters on Windows (C:, D:, etc.) to focus on folder structure
    normalized = normalized.replace(/^[A-Za-z]:/, '');
    
    // Ensure it starts with a forward slash
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    
    // Remove any double slashes
    normalized = normalized.replace(/\/+/g, '/');
    
    // Remove trailing slash unless it's the root
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    
    return normalized;
  }

  /**
   * Extract the folder path from a file path
   * @param {string} filePath - The full file path
   * @returns {string} - The folder path without the filename
   */
  extractFolderPath(filePath) {
    if (!filePath) return '';
    
    // Normalize path separators
    const normalized = filePath.replace(/\\/g, '/');
    
    // Find the last slash to separate folder from filename
    const lastSlashIndex = normalized.lastIndexOf('/');
    
    if (lastSlashIndex === -1) {
      // No folder separator found, check if it's a drive root
      if (normalized.match(/^[A-Za-z]:$/)) {
        return ''; // Drive root has no parent
      }
      return '';
    }
    
    // Return everything up to (but not including) the last slash
    const folderPath = normalized.substring(0, lastSlashIndex);
    
    // Handle drive root cases properly
    if (folderPath.match(/^[A-Za-z]:$/)) {
      return folderPath; // Return drive root as-is
    }
    
    // Ensure we don't return an empty string for valid paths
    return folderPath || '/';
  }

  /**
   * Extract the folder name from a folder path
   * @param {string} folderPath - The folder path
   * @returns {string} - The name of the deepest folder
   */
  extractFolderName(folderPath) {
    if (!folderPath || folderPath === '/' || folderPath === '') return 'Root';
    
    // Handle drive roots specifically
    if (folderPath.match(/^[A-Za-z]:$/)) {
      return folderPath; // Drive name is the folder name
    }
    
    // Normalize path separators
    const normalized = folderPath.replace(/\\/g, '/');
    
    // Remove trailing slash if present
    const cleaned = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
    
    // Find the last slash to get the folder name
    const lastSlashIndex = cleaned.lastIndexOf('/');
    
    if (lastSlashIndex === -1) {
      // No slash found, the entire string is the folder name
      return cleaned || 'Root';
    }
    
    // Return everything after the last slash
    const folderName = cleaned.substring(lastSlashIndex + 1);
    
    return folderName || 'Root';
  }

  /**
   * Establish parent-child relationships for folders
   * This is a second pass after the initial migration to link folders properly
   */
  async establishFolderHierarchy() {
    try {
      console.log('🔗 Establishing folder parent-child relationships...');
      
      // Get all folders that don't have a parent_folder_id set
      const [foldersWithoutParents] = await this.connection.execute(
        'SELECT id, full_path, normalized_path FROM folders WHERE parent_folder_id IS NULL ORDER BY LENGTH(full_path)'
      );
      
      console.log(`📁 Found ${foldersWithoutParents.length.toLocaleString()} folders to process for parent relationships`);
      
      let updated = 0;
      let skipped = 0;
      
      for (const folder of foldersWithoutParents) {
        try {
          // Get the parent path
          const parentPath = this.extractFolderPath(folder.full_path);
          
          // Skip if this is a root folder (no parent)
          if (!parentPath || parentPath === '/' || parentPath === '' || parentPath === folder.full_path) {
            skipped++;
            continue;
          }
          
          // Find the parent folder
          const normalizedParentPath = this.normalizePath(parentPath);
          const [parentFolders] = await this.connection.execute(
            'SELECT id FROM folders WHERE full_path = ? OR normalized_path = ? LIMIT 1',
            [parentPath, normalizedParentPath]
          );
          
          if (parentFolders.length > 0) {
            // Update the folder with its parent ID
            await this.connection.execute(
              'UPDATE folders SET parent_folder_id = ? WHERE id = ?',
              [parentFolders[0].id, folder.id]
            );
            updated++;
            
            if (updated % 1000 === 0) {
              console.log(`📈 Progress: ${updated.toLocaleString()} parent relationships established`);
            }
          } else {
            // Parent folder doesn't exist, which is fine for some cases
            skipped++;
          }
          
        } catch (error) {
          console.error(`⚠️  Error processing folder ${folder.full_path}:`, error.message);
          skipped++;
        }
      }
      
      console.log(`✅ Folder hierarchy establishment completed!`);
      console.log(`📁 Updated: ${updated.toLocaleString()} folders with parent relationships`);
      console.log(`⏭️  Skipped: ${skipped.toLocaleString()} folders (root folders or missing parents)`);
      
      // Show some statistics
      const [totalFolders] = await this.connection.execute('SELECT COUNT(*) as count FROM folders');
      const [withParents] = await this.connection.execute('SELECT COUNT(*) as count FROM folders WHERE parent_folder_id IS NOT NULL');
      const [rootFolders] = await this.connection.execute('SELECT COUNT(*) as count FROM folders WHERE parent_folder_id IS NULL');
      
      console.log(`\n📊 Final Hierarchy Statistics:`);
      console.log(`   Total folders: ${totalFolders[0].count.toLocaleString()}`);
      console.log(`   Folders with parents: ${withParents[0].count.toLocaleString()}`);
      console.log(`   Root folders: ${rootFolders[0].count.toLocaleString()}`);
      
    } catch (error) {
      console.error('❌ Folder hierarchy establishment failed:', error.message);
      throw error;
    }
  }

  /**
   * Create missing parent folders and establish complete hierarchy
   * This creates intermediate folders that don't have files but are needed for hierarchy
   */
  async createMissingParentFolders() {
    try {
      console.log('📁 Creating missing parent folders...');
      
      // Get all folders that don't have parents but should have them
      const [orphanFolders] = await this.connection.execute(`
        SELECT id, full_path, normalized_path, folder_name 
        FROM folders 
        WHERE parent_folder_id IS NULL 
        AND full_path NOT REGEXP '^[A-Za-z]:/?$'
        AND (full_path LIKE '%/%' OR full_path LIKE '%\\\\%')
        ORDER BY LENGTH(full_path)
      `);
      
      console.log(`🔍 Found ${orphanFolders.length.toLocaleString()} orphaned folders to process`);
      
      let created = 0;
      let linked = 0;
      const createdPaths = new Set();
      
      for (const folder of orphanFolders) {
        try {
          // Get all parent paths up to the root
          const parentPaths = this.getAllParentPaths(folder.full_path);
          
          // Create missing parent folders from top to bottom
          let lastParentId = null;
          
          for (const parentPath of parentPaths) {
            if (createdPaths.has(parentPath)) {
              // Already processed this path in this run
              const [existing] = await this.connection.execute(
                'SELECT id FROM folders WHERE full_path = ? OR normalized_path = ?',
                [parentPath, this.normalizePath(parentPath)]
              );
              if (existing.length > 0) {
                lastParentId = existing[0].id;
              }
              continue;
            }
            
            // Check if this parent folder already exists
            const normalizedParentPath = this.normalizePath(parentPath);
            const [existing] = await this.connection.execute(
              'SELECT id FROM folders WHERE full_path = ? OR normalized_path = ?',
              [parentPath, normalizedParentPath]
            );
            
            if (existing.length > 0) {
              lastParentId = existing[0].id;
            } else {
              // Create the missing parent folder
              const folderName = this.extractFolderName(parentPath);
              
              const [result] = await this.connection.execute(
                `INSERT INTO folders (parent_folder_id, folder_name, full_path, normalized_path, file_count, total_size)
                 VALUES (?, ?, ?, ?, 0, 0)`,
                [lastParentId, folderName, parentPath, normalizedParentPath]
              );
              
              lastParentId = result.insertId;
              created++;
              createdPaths.add(parentPath);
              
              if (created % 100 === 0) {
                console.log(`📈 Progress: Created ${created} missing parent folders`);
              }
            }
          }
          
          // Now link the original folder to its immediate parent
          if (lastParentId) {
            await this.connection.execute(
              'UPDATE folders SET parent_folder_id = ? WHERE id = ?',
              [lastParentId, folder.id]
            );
            linked++;
          }
          
        } catch (error) {
          console.error(`⚠️  Error processing folder ${folder.full_path}:`, error.message);
        }
      }
      
      console.log(`✅ Missing parent folder creation completed!`);
      console.log(`📁 Created: ${created.toLocaleString()} missing parent folders`);
      console.log(`🔗 Linked: ${linked.toLocaleString()} orphaned folders to parents`);
      
      // Show final statistics
      const [totalFolders] = await this.connection.execute('SELECT COUNT(*) as count FROM folders');
      const [withParents] = await this.connection.execute('SELECT COUNT(*) as count FROM folders WHERE parent_folder_id IS NOT NULL');
      const [rootFolders] = await this.connection.execute('SELECT COUNT(*) as count FROM folders WHERE parent_folder_id IS NULL');
      
      console.log(`\n📊 Final Complete Hierarchy Statistics:`);
      console.log(`   Total folders: ${totalFolders[0].count.toLocaleString()}`);
      console.log(`   Folders with parents: ${withParents[0].count.toLocaleString()}`);
      console.log(`   Root folders: ${rootFolders[0].count.toLocaleString()}`);
      
    } catch (error) {
      console.error('❌ Missing parent folder creation failed:', error.message);
      throw error;
    }
  }

  /**
   * Get all parent paths for a given path, from immediate parent to root
   * @param {string} fullPath - The full path
   * @returns {Array} - Array of parent paths from top-level to immediate parent
   */
  getAllParentPaths(fullPath) {
    const paths = [];
    let currentPath = fullPath;
    
    while (true) {
      const parentPath = this.extractFolderPath(currentPath);
      
      // Stop if we've reached the root or if no valid parent
      if (!parentPath || parentPath === currentPath || parentPath === '/' || parentPath === '' || 
          parentPath.match(/^[A-Za-z]:?[\/\\]?$/)) {
        break;
      }
      
      paths.unshift(parentPath); // Add to beginning to get top-down order
      currentPath = parentPath;
    }
    
    return paths;
  }

  /**
   * Find or create a folder record and return its ID
   * @param {string} fullPath - The original full path
   * @param {string} folderPath - The folder portion of the path
   * @returns {number} - The folder ID
   */
  async findOrCreateFolder(fullPath, folderPath) {
    if (!folderPath) folderPath = this.extractFolderPath(fullPath);
    
    // Validate input
    if (!folderPath || folderPath === '') {
      throw new Error('Invalid folder path provided');
    }
    
    const normalizedPath = this.normalizePath(folderPath);
    const folderName = this.extractFolderName(folderPath);
    
    // Try to find existing folder
    const [existing] = await this.connection.execute(
      'SELECT id FROM folders WHERE full_path = ? OR normalized_path = ?',
      [folderPath, normalizedPath]
    );
    
    if (existing.length > 0) {
      return existing[0].id;
    }
    
    // Handle drive roots specially
    if (folderPath.match(/^[A-Za-z]:$/)) {
      // This is a drive root - create without parent
      const [result] = await this.connection.execute(
        `INSERT INTO folders (parent_folder_id, folder_name, full_path, normalized_path, file_count, total_size)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [null, folderName, folderPath, '/', 0, 0]
      );
      return result.insertId;
    }
    
    // Find parent folder ID for non-root folders
    let parentFolderId = null;
    const parentPath = this.extractFolderPath(folderPath);
    
    if (parentPath && parentPath !== folderPath && parentPath !== '/' && parentPath !== '') {
      // Recursively ensure parent exists
      parentFolderId = await this.findOrCreateFolder(null, parentPath);
    }
    
    // Create new folder with proper parent relationship
    try {
      const [result] = await this.connection.execute(
        `INSERT INTO folders (parent_folder_id, folder_name, full_path, normalized_path, file_count, total_size)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [parentFolderId, folderName, folderPath, normalizedPath, 0, 0]
      );
      
      return result.insertId;
    } catch (insertError) {
      // Check if this is a duplicate key error (race condition)
      if (insertError.code === 'ER_DUP_ENTRY') {
        // Try to find the folder again (it might have been created by another process)
        const [retry] = await this.connection.execute(
          'SELECT id FROM folders WHERE full_path = ? OR normalized_path = ?',
          [folderPath, normalizedPath]
        );
        
        if (retry.length > 0) {
          return retry[0].id;
        }
      }
      
      console.error(`Error creating folder ${folderPath}:`, insertError.message);
      throw insertError;
    }
  }

  /**
   * Bulk create multiple folders at once for better performance
   * @param {Array} folderPaths - Array of folder paths to create
   * @returns {Map} - Map of folderPath -> folderId
   */
  async bulkCreateFolders(folderPaths) {
    const folderMap = new Map();
    
    if (folderPaths.length === 0) return folderMap;
    
    // Process in smaller chunks to avoid "Malformed communication packet" errors
    const chunkSize = 50; // Reduced chunk size for safety
    
    for (let i = 0; i < folderPaths.length; i += chunkSize) {
      const chunk = folderPaths.slice(i, i + chunkSize);
      
      // First, check which folders already exist in this chunk
      const normalizedPaths = chunk.map(path => this.normalizePath(path));
      const allPaths = [...chunk, ...normalizedPaths];
      
      if (allPaths.length > 0) {
        const placeholders = allPaths.map(() => '?').join(',');
        const [existing] = await this.connection.execute(
          `SELECT id, full_path, normalized_path FROM folders WHERE full_path IN (${placeholders}) OR normalized_path IN (${placeholders})`,
          allPaths
        );
        
        // Map existing folders
        for (const folder of existing) {
          const originalPath = chunk.find(p => p === folder.full_path || this.normalizePath(p) === folder.normalized_path);
          if (originalPath) {
            folderMap.set(originalPath, folder.id);
          }
        }
      }
      
      // Create missing folders in this chunk
      const missingPaths = chunk.filter(path => !folderMap.has(path));
      
      for (const folderPath of missingPaths) {
        try {
          const folderId = await this.findOrCreateFolder(null, folderPath);
          folderMap.set(folderPath, folderId);
        } catch (error) {
          console.error(`⚠️  Failed to create folder ${folderPath}:`, error.message);
        }
      }
    }
    
    return folderMap;
  }

  /**
   * Update folder statistics (file count and total size)
   * @param {number} folderId - The folder ID to update
   */
  async updateFolderStats(folderId) {
    const [stats] = await this.connection.execute(
      `SELECT COUNT(*) as file_count, COALESCE(SUM(size), 0) as total_size
       FROM scanned_files WHERE folder_id = ?`,
      [folderId]
    );
    
    await this.connection.execute(
      'UPDATE folders SET file_count = ?, total_size = ? WHERE id = ?',
      [stats[0].file_count, stats[0].total_size, folderId]
    );
  }

  /**
   * Migrate existing files to use normalized folder structure
   */
  async migrateFoldersNormalization() {
    try {
      console.log('🚀 Starting folder normalization migration...');
      
      // First, ensure the folders table exists
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS folders (
          id INT AUTO_INCREMENT PRIMARY KEY,
          parent_folder_id INT DEFAULT NULL,
          folder_name VARCHAR(512) NOT NULL,
          full_path VARCHAR(2048) NOT NULL,
          normalized_path VARCHAR(2048) NOT NULL,
          file_count INT DEFAULT 0,
          total_size BIGINT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (parent_folder_id) REFERENCES folders(id) ON DELETE SET NULL,
          INDEX idx_full_path (full_path(191)),
          INDEX idx_normalized_path (normalized_path(191)),
          INDEX idx_parent_folder (parent_folder_id),
          INDEX idx_folder_name (folder_name(191))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      
      // Check if folder_id column exists in scanned_files table
      const [columns] = await this.connection.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
         WHERE table_schema = DATABASE() AND table_name = 'scanned_files' AND column_name = 'folder_id'`
      );
      
      if (columns.length === 0) {
        console.log('📁 Adding folder_id column to scanned_files table...');
        await this.connection.execute(
          'ALTER TABLE scanned_files ADD COLUMN folder_id INT DEFAULT NULL'
        );
        await this.connection.execute(
          'ALTER TABLE scanned_files ADD INDEX idx_folder_id (folder_id)'
        );
        
        // Add foreign key constraint more carefully
        try {
          await this.connection.execute(
            'ALTER TABLE scanned_files ADD CONSTRAINT fk_scanned_files_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL'
          );
        } catch (fkError) {
          console.log('⚠️  Foreign key constraint creation skipped (may already exist)');
        }
      }
      
      // Get count of files to migrate
      const [countResult] = await this.connection.execute(
        'SELECT COUNT(*) as total FROM scanned_files WHERE folder_id IS NULL'
      );
      const totalFiles = countResult[0].total;
      
      if (totalFiles === 0) {
        console.log('✅ All files already have folder associations');
        return;
      }
      
      console.log(`📊 Migrating ${totalFiles.toLocaleString()} files...`);
      
      const batchSize = 5000; // Larger batch for bulk processing
      let processed = 0;
      let errors = 0;
      
      while (processed < totalFiles) {
        try {
          const [files] = await this.connection.execute(
            `SELECT id, path FROM scanned_files WHERE folder_id IS NULL LIMIT ${batchSize}`
          );
          
          if (files.length === 0) break;
          
          // Group files by their folder paths for bulk processing
          console.log(`🔄 Processing batch of ${files.length} files...`);
          const folderGroups = new Map();
          
          for (const file of files) {
            const folderPath = this.extractFolderPath(file.path);
            if (!folderGroups.has(folderPath)) {
              folderGroups.set(folderPath, []);
            }
            folderGroups.get(folderPath).push(file);
          }
          
          console.log(`📁 Found ${folderGroups.size} unique folders in this batch`);
          
          // Process each folder group with folder caching for better performance
          const folderCache = new Map(); // Cache folder IDs during batch processing
          
          for (const [folderPath, groupFiles] of folderGroups) {
            try {
              // Check cache first
              let folderId = folderCache.get(folderPath);
              
              if (!folderId) {
                // Create or find the folder once for all files in this path
                folderId = await this.findOrCreateFolder(groupFiles[0].path, folderPath);
                folderCache.set(folderPath, folderId);
              }
              
              // Bulk update all files in this folder using a single query
              const fileIds = groupFiles.map(f => f.id);
              
              // Use IN clause for bulk update - more efficient than individual updates
              if (fileIds.length === 1) {
                await this.connection.execute(
                  'UPDATE scanned_files SET folder_id = ? WHERE id = ?',
                  [folderId, fileIds[0]]
                );
              } else if (fileIds.length <= 100) {
                // Safe batch size for IN clause
                const placeholders = fileIds.map(() => '?').join(',');
                await this.connection.execute(
                  `UPDATE scanned_files SET folder_id = ? WHERE id IN (${placeholders})`,
                  [folderId, ...fileIds]
                );
              } else {
                // Split very large groups into smaller batches
                for (let i = 0; i < fileIds.length; i += 100) {
                  const chunk = fileIds.slice(i, i + 100);
                  const placeholders = chunk.map(() => '?').join(',');
                  await this.connection.execute(
                    `UPDATE scanned_files SET folder_id = ? WHERE id IN (${placeholders})`,
                    [folderId, ...chunk]
                  );
                }
              }
              
            } catch (folderError) {
              console.error(`⚠️  Error processing folder ${folderPath}:`, folderError.message);
              errors++;
              continue;
            }
          }
          
          processed += files.length;
          const percent = Math.round((processed / totalFiles) * 100);
          console.log(`📈 Progress: ${processed.toLocaleString()}/${totalFiles.toLocaleString()} (${percent}%) [Errors: ${errors}] [Folders: ${folderGroups.size}]`);
          
        } catch (batchError) {
          console.error(`❌ Batch processing error:`, batchError.message);
          errors++;
          
          // If we get repeated batch errors, stop the migration
          if (errors > 10) {
            throw new Error(`Too many errors (${errors}), stopping migration`);
          }
          
          // Small delay before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      // Update all folder statistics
      console.log('📊 Updating folder statistics...');
      const [folders] = await this.connection.execute('SELECT id FROM folders');
      
      for (const folder of folders) {
        await this.updateFolderStats(folder.id);
      }
      
      console.log('✅ Folder normalization migration completed successfully!');
      
      // Show summary
      const [folderCount] = await this.connection.execute('SELECT COUNT(*) as count FROM folders');
      const [fileCount] = await this.connection.execute('SELECT COUNT(*) as count FROM scanned_files WHERE folder_id IS NOT NULL');
      
      console.log(`📁 Created ${folderCount[0].count.toLocaleString()} folder records`);
      console.log(`📄 Associated ${fileCount[0].count.toLocaleString()} files with folders`);
      
    } catch (error) {
      console.error('❌ Migration failed:', error.message);
      throw error;
    }
  }

  /**
   * Update folder sizes and file counts based on actual files
   * This calculates the total size and count of files in each folder
   */
  async updateFolderStatistics() {
    try {
      console.log('📊 Updating folder statistics (size and file count)...');
      
      // Get all folders
      const [folders] = await this.connection.execute('SELECT id, full_path FROM folders ORDER BY id');
      console.log(`🔍 Processing ${folders.length.toLocaleString()} folders...`);
      
      let updated = 0;
      let totalFiles = 0;
      let totalSize = 0;
      
      // Process folders in batches for better performance
      const batchSize = 100;
      
      for (let i = 0; i < folders.length; i += batchSize) {
        const batch = folders.slice(i, i + batchSize);
        
        for (const folder of batch) {
          try {
            // Get direct files in this folder (not including subfolders)
            const [fileStats] = await this.connection.execute(`
              SELECT 
                COUNT(*) as file_count,
                COALESCE(SUM(size), 0) as total_size
              FROM scanned_files 
              WHERE folder_id = ?
            `, [folder.id]);
            
            const stats = fileStats[0];
            const fileCount = parseInt(stats.file_count) || 0;
            const folderSize = parseInt(stats.total_size) || 0;
            
            // Update folder statistics
            await this.connection.execute(`
              UPDATE folders 
              SET file_count = ?, total_size = ? 
              WHERE id = ?
            `, [fileCount, folderSize, folder.id]);
            
            updated++;
            totalFiles += fileCount;
            totalSize += folderSize;
            
            if (updated % 1000 === 0) {
              console.log(`📈 Progress: ${updated.toLocaleString()}/${folders.length.toLocaleString()} folders updated`);
            }
            
          } catch (error) {
            console.error(`⚠️ Error updating folder ${folder.full_path}:`, error.message);
          }
        }
      }
      
      console.log(`✅ Folder statistics update completed!`);
      console.log(`📁 Updated: ${updated.toLocaleString()} folders`);
      console.log(`📄 Total files: ${totalFiles.toLocaleString()}`);
      console.log(`💾 Total size: ${this.formatBytes(totalSize)}`);
      
      // Show some sample statistics
      console.log('\n📊 Sample folder statistics:');
      const [sampleStats] = await this.connection.execute(`
        SELECT 
          full_path,
          file_count,
          total_size
        FROM folders 
        WHERE file_count > 0 
        ORDER BY total_size DESC 
        LIMIT 10
      `);
      
      for (const folder of sampleStats) {
        console.log(`   📂 ${folder.full_path}: ${folder.file_count} files, ${this.formatBytes(folder.total_size)}`);
      }
      
    } catch (error) {
      console.error('❌ Folder statistics update failed:', error.message);
      throw error;
    }
  }

  /**
   * Get folder statistics for specific path or pattern
   * @param {string} pathPattern - Path pattern to search for (can include wildcards)
   * @param {boolean} includeSubfolders - Whether to include subfolder totals
   */
  async getFolderStatistics(pathPattern = '', includeSubfolders = false) {
    try {
      let whereClause = '';
      let queryParams = [];
      
      if (pathPattern) {
        if (pathPattern.includes('*') || pathPattern.includes('%')) {
          // Pattern matching
          whereClause = 'WHERE full_path LIKE ?';
          queryParams.push(pathPattern.replace(/\*/g, '%'));
        } else {
          // Exact path or prefix matching
          whereClause = 'WHERE full_path = ? OR full_path LIKE ?';
          queryParams.push(pathPattern, pathPattern + '/%');
        }
      }
      
      const [results] = await this.connection.execute(`
        SELECT 
          id,
          full_path,
          folder_name,
          file_count,
          total_size,
          parent_folder_id
        FROM folders 
        ${whereClause}
        ORDER BY total_size DESC, file_count DESC
      `, queryParams);
      
      // If includeSubfolders is true, calculate recursive totals
      if (includeSubfolders && results.length > 0) {
        for (const folder of results) {
          const [subfolderStats] = await this.connection.execute(`
            WITH RECURSIVE folder_tree AS (
              SELECT id, file_count, total_size FROM folders WHERE id = ?
              UNION ALL
              SELECT f.id, f.file_count, f.total_size 
              FROM folders f
              INNER JOIN folder_tree ft ON f.parent_folder_id = ft.id
            )
            SELECT 
              SUM(file_count) as recursive_file_count,
              SUM(total_size) as recursive_total_size
            FROM folder_tree
          `, [folder.id]);
          
          if (subfolderStats.length > 0) {
            folder.recursive_file_count = parseInt(subfolderStats[0].recursive_file_count) || 0;
            folder.recursive_total_size = parseInt(subfolderStats[0].recursive_total_size) || 0;
          }
        }
      }
      
      return results;
      
    } catch (error) {
      console.error('❌ Error getting folder statistics:', error.message);
      throw error;
    }
  }

  /**
   * Find duplicate folders by size and file count
   * @param {number} minSize - Minimum folder size in bytes
   * @param {number} minFileCount - Minimum number of files in folder
   * @returns {Array} Array of duplicate folder groups
   */
  async findDuplicateFolders(minSize = 0, minFileCount = 1) {
    try {
      console.log('🔍 Finding duplicate folders by size and file count...');
      
      // Find folders with same size and file count (potential duplicates)
      const [duplicateCandidates] = await this.connection.execute(`
        SELECT 
          total_size,
          file_count,
          COUNT(*) as folder_count,
          GROUP_CONCAT(id) as folder_ids
        FROM folders 
        WHERE total_size >= ? 
        AND file_count >= ?
        AND total_size > 0
        GROUP BY total_size, file_count
        HAVING COUNT(*) > 1
        ORDER BY total_size DESC, file_count DESC
      `, [minSize, minFileCount]);
      
      if (duplicateCandidates.length === 0) {
        console.log('✅ No duplicate folders found');
        return [];
      }
      
      console.log(`📁 Found ${duplicateCandidates.length} potential duplicate folder groups`);
      
      // Get detailed information for each duplicate group
      const duplicateGroups = [];
      
      for (const candidate of duplicateCandidates) {
        const folderIds = candidate.folder_ids.split(',').map(id => parseInt(id));
        
        // Get full details for folders in this group
        const [folders] = await this.connection.execute(`
          SELECT 
            id,
            full_path,
            folder_name,
            file_count,
            total_size,
            parent_folder_id
          FROM folders 
          WHERE id IN (${folderIds.map(() => '?').join(',')})
          ORDER BY full_path
        `, folderIds);
        
        // Calculate wasted space (all folders except one are "waste")
        const wastedSpace = (folders.length - 1) * candidate.total_size;
        
        duplicateGroups.push({
          size: candidate.total_size,
          fileCount: candidate.file_count,
          folderCount: folders.length,
          wastedSpace: wastedSpace,
          folders: folders
        });
      }
      
      // Sort by wasted space (highest first)
      duplicateGroups.sort((a, b) => b.wastedSpace - a.wastedSpace);
      
      console.log(`✅ Found ${duplicateGroups.length} duplicate folder groups`);
      
      return duplicateGroups;
      
    } catch (error) {
      console.error('❌ Error finding duplicate folders:', error.message);
      throw error;
    }
  }

  /**
   * Generate HTML report for duplicate folders
   * @param {Array} duplicateGroups - Array of duplicate folder groups
   * @param {string} outputPath - Path to save HTML report
   */
  async generateDuplicateFoldersReport(duplicateGroups, outputPath) {
    try {
      const totalWastedSpace = duplicateGroups.reduce((sum, group) => sum + group.wastedSpace, 0);
      const totalFolders = duplicateGroups.reduce((sum, group) => sum + group.folderCount, 0);
      const totalGroups = duplicateGroups.length;
      
      // Helper function to extract last 2 folder names from path
      const getLastTwoFolders = (fullPath) => {
        const parts = fullPath.replace(/\\/g, '/').split('/').filter(part => part.length > 0);
        if (parts.length <= 2) {
          return fullPath;
        }
        return '.../' + parts.slice(-2).join('/');
      };
      
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Duplicate Folders Report - SilverFileSystem</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: rgba(255, 255, 255, 0.95);
            border-radius: 15px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #2c3e50 0%, #3498db 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }

        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
        }

        .header p {
            font-size: 1.1em;
            opacity: 0.9;
        }

        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            padding: 30px;
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
        }

        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
            transition: transform 0.3s ease;
        }

        .stat-card:hover {
            transform: translateY(-5px);
        }

        .stat-number {
            font-size: 2em;
            font-weight: bold;
            color: #e74c3c;
            margin-bottom: 5px;
        }

        .stat-label {
            color: #7f8c8d;
            text-transform: uppercase;
            font-size: 0.9em;
            letter-spacing: 1px;
        }

        .controls {
            padding: 20px 30px;
            background: #f8f9fa;
            border-bottom: 1px solid #dee2e6;
        }

        .search-box {
            width: 100%;
            padding: 12px 20px;
            border: 2px solid #ddd;
            border-radius: 25px;
            font-size: 16px;
            outline: none;
            transition: border-color 0.3s ease;
        }

        .search-box:focus {
            border-color: #3498db;
        }

        .filters {
            margin-top: 15px;
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            align-items: center;
        }

        .filter-btn {
            padding: 8px 16px;
            border: 2px solid #3498db;
            background: white;
            color: #3498db;
            border-radius: 20px;
            cursor: pointer;
            transition: all 0.3s ease;
            font-size: 14px;
        }

        .filter-btn:hover, .filter-btn.active {
            background: #3498db;
            color: white;
        }

        .content {
            padding: 30px;
            max-height: 70vh;
            overflow-y: auto;
        }

        .duplicate-group {
            background: white;
            margin-bottom: 20px;
            border-radius: 10px;
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
            overflow: hidden;
            transition: transform 0.3s ease;
        }

        .duplicate-group:hover {
            transform: translateY(-2px);
        }

        .group-header {
            background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
            color: white;
            padding: 20px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            flex-wrap: wrap;
            gap: 15px;
        }

        .group-main-info {
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
            align-items: center;
            flex: 1;
        }

        .group-folder-names {
            flex: 1;
            min-width: 200px;
        }

        .folder-name-item {
            background: rgba(255, 255, 255, 0.1);
            padding: 5px 10px;
            margin: 2px 0;
            border-radius: 15px;
            font-size: 0.9em;
            display: inline-block;
            margin-right: 8px;
        }

        .group-stats {
            display: flex;
            flex-wrap: wrap;
            gap: 15px;
            align-items: center;
        }

        .info-item {
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .info-value {
            font-size: 1.2em;
            font-weight: bold;
        }

        .info-label {
            font-size: 0.8em;
            opacity: 0.8;
            text-transform: uppercase;
        }

        .expand-icon {
            font-size: 1.5em;
            transition: transform 0.3s ease;
        }

        .duplicate-group.expanded .expand-icon {
            transform: rotate(180deg);
        }

        .folder-list {
            display: none;
            padding: 20px;
            background: #f8f9fa;
        }

        .duplicate-group.expanded .folder-list {
            display: block;
        }

        .folder-item {
            background: white;
            margin-bottom: 10px;
            padding: 15px;
            border-radius: 8px;
            border-left: 4px solid #3498db;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: all 0.3s ease;
        }

        .folder-item:hover {
            background: #e3f2fd;
            border-left-color: #2196f3;
        }

        .folder-path {
            font-family: 'Courier New', monospace;
            color: #2c3e50;
            word-break: break-all;
            flex: 1;
        }

        .folder-path-full {
            font-size: 0.95em;
            color: #2c3e50;
            font-family: 'Courier New', monospace;
            word-break: break-all;
        }

        .folder-details {
            color: #7f8c8d;
            font-size: 0.9em;
            text-align: right;
        }

        .no-results {
            text-align: center;
            padding: 50px;
            color: #7f8c8d;
            font-size: 1.2em;
        }

        .footer {
            background: #2c3e50;
            color: white;
            text-align: center;
            padding: 20px;
            font-size: 0.9em;
        }

        @media (max-width: 768px) {
            .header h1 {
                font-size: 2em;
            }
            
            .group-main-info {
                flex-direction: column;
                gap: 10px;
            }
            
            .group-stats {
                flex-direction: column;
                gap: 5px;
                align-items: flex-start;
            }
            
            .folder-item {
                flex-direction: column;
                align-items: flex-start;
                gap: 10px;
            }
            
            .folder-name-item {
                display: block;
                margin: 2px 0;
                margin-right: 0;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📁 Duplicate Folders Report</h1>
            <p>Generated on ${new Date().toLocaleString()} by SilverFileSystem</p>
        </div>

        <div class="stats">
            <div class="stat-card">
                <div class="stat-number">${totalGroups.toLocaleString()}</div>
                <div class="stat-label">Duplicate Groups</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${totalFolders.toLocaleString()}</div>
                <div class="stat-label">Total Folders</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${this.formatBytes(totalWastedSpace)}</div>
                <div class="stat-label">Wasted Space</div>
            </div>
        </div>

        <div class="controls">
            <input type="text" id="searchBox" class="search-box" placeholder="🔍 Search folders by path or name...">
            <div class="filters">
                <button class="filter-btn active" data-filter="all">All Groups</button>
                <button class="filter-btn" data-filter="large">Large Folders (>100MB)</button>
                <button class="filter-btn" data-filter="many-files">Many Files (>50)</button>
                <button class="filter-btn" data-filter="high-waste">High Waste (>1GB)</button>
            </div>
        </div>

        <div class="content">
            <div id="duplicatesList">
                ${duplicateGroups.map((group, index) => `
                    <div class="duplicate-group" data-size="${group.size}" data-waste="${group.wastedSpace}" data-files="${group.fileCount}">
                        <div class="group-header" onclick="toggleGroup(${index})">
                            <div class="group-main-info">
                                <div class="group-folder-names">
                                    <div style="font-weight: bold; margin-bottom: 5px;">📁 Duplicate Folders:</div>
                                    ${group.folders.map(folder => `
                                        <span class="folder-name-item" title="${folder.full_path}">${getLastTwoFolders(folder.full_path)}</span>
                                    `).join('')}
                                </div>
                                <div class="group-stats">
                                    <div class="info-item">
                                        <div class="info-value">${group.folderCount}</div>
                                        <div class="info-label">Folders</div>
                                    </div>
                                    <div class="info-item">
                                        <div class="info-value">${this.formatBytes(group.size)}</div>
                                        <div class="info-label">Size Each</div>
                                    </div>
                                    <div class="info-item">
                                        <div class="info-value">${group.fileCount.toLocaleString()}</div>
                                        <div class="info-label">Files Each</div>
                                    </div>
                                    <div class="info-item">
                                        <div class="info-value">${this.formatBytes(group.wastedSpace)}</div>
                                        <div class="info-label">Wasted Space</div>
                                    </div>
                                </div>
                            </div>
                            <div class="expand-icon">▼</div>
                        </div>
                        <div class="folder-list">
                            ${group.folders.map(folder => `
                                <div class="folder-item">
                                    <div class="folder-path">
                                        <div class="folder-path-full">${folder.full_path}</div>
                                    </div>
                                    <div class="folder-details">
                                        ID: ${folder.id}<br>
                                        Name: ${folder.folder_name}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
            <div id="noResults" class="no-results" style="display: none;">
                📭 No duplicate folders match your search criteria
            </div>
        </div>

        <div class="footer">
            <p>🚀 Generated by SilverFileSystem - Advanced File Management Tool</p>
            <p>Total analysis completed on ${totalFolders.toLocaleString()} folders</p>
        </div>
    </div>

    <script>
        function toggleGroup(index) {
            const groups = document.querySelectorAll('.duplicate-group');
            const group = groups[index];
            group.classList.toggle('expanded');
        }

        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        // Search functionality
        document.getElementById('searchBox').addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            const groups = document.querySelectorAll('.duplicate-group');
            let visibleCount = 0;

            groups.forEach(group => {
                // Search in both short names and full paths
                const shortNames = Array.from(group.querySelectorAll('.folder-name-item'))
                    .map(el => el.textContent.toLowerCase());
                const fullPaths = Array.from(group.querySelectorAll('.folder-path-full'))
                    .map(el => el.textContent.toLowerCase());
                
                const matches = [...shortNames, ...fullPaths].some(text => text.includes(searchTerm));
                
                if (matches) {
                    group.style.display = 'block';
                    visibleCount++;
                } else {
                    group.style.display = 'none';
                }
            });

            document.getElementById('noResults').style.display = 
                visibleCount === 0 ? 'block' : 'none';
        });

        // Filter functionality
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                // Update active button
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                this.classList.add('active');

                const filter = this.dataset.filter;
                const groups = document.querySelectorAll('.duplicate-group');
                let visibleCount = 0;

                groups.forEach(group => {
                    let show = true;
                    const size = parseInt(group.dataset.size);
                    const waste = parseInt(group.dataset.waste);
                    const files = parseInt(group.dataset.files);

                    switch(filter) {
                        case 'large':
                            show = size > 100 * 1024 * 1024; // > 100MB
                            break;
                        case 'many-files':
                            show = files > 50;
                            break;
                        case 'high-waste':
                            show = waste > 1024 * 1024 * 1024; // > 1GB
                            break;
                        case 'all':
                        default:
                            show = true;
                            break;
                    }

                    if (show) {
                        group.style.display = 'block';
                        visibleCount++;
                    } else {
                        group.style.display = 'none';
                    }
                });

                document.getElementById('noResults').style.display = 
                    visibleCount === 0 ? 'block' : 'none';
            });
        });

        // Auto-expand first group if there are results
        if (document.querySelectorAll('.duplicate-group').length > 0) {
            toggleGroup(0);
        }
    </script>
</body>
</html>`;

      const fs = await import('fs');
      await fs.promises.writeFile(outputPath, html, 'utf8');
      
      console.log(`✅ HTML report generated: ${outputPath}`);
      console.log(`📊 Report contains ${totalGroups} duplicate groups with ${this.formatBytes(totalWastedSpace)} wasted space`);
      
      return outputPath;
      
    } catch (error) {
      console.error('❌ Error generating HTML report:', error.message);
      throw error;
    }
  }

  /**
   * Format bytes to human readable format
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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
