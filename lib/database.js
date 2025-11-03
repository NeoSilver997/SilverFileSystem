import { json } from 'express';
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
          is_duplicate BOOLEAN DEFAULT FALSE,
          duplicate_group_id INT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_path (path(255)),
          INDEX idx_size (size),
          INDEX idx_hash (hash),
          INDEX idx_quick_hash (quick_hash),
          INDEX idx_extension (extension),
          INDEX idx_scan_id (scan_id),
          INDEX idx_is_duplicate (is_duplicate),
          INDEX idx_duplicate_group_id (duplicate_group_id)
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

      // Create users table for authentication
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          google_id VARCHAR(255) UNIQUE NOT NULL,
          email VARCHAR(255) NOT NULL,
          name VARCHAR(255),
          picture VARCHAR(512),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_google_id (google_id),
          INDEX idx_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      // Create music ratings table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS music_ratings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          file_id INT NOT NULL,
          user_id INT,
          rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (file_id) REFERENCES scanned_files(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE KEY unique_file_user_rating (file_id, user_id),
          INDEX idx_file_id (file_id),
          INDEX idx_user_id (user_id),
          INDEX idx_rating (rating)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      // Create music play history table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS music_play_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          file_id INT NOT NULL,
          user_id INT,
          played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (file_id) REFERENCES scanned_files(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
          INDEX idx_file_id (file_id),
          INDEX idx_user_id (user_id),
          INDEX idx_played_at (played_at)
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

      // Add duplicate tracking columns if they don't exist
      try {
        await this.connection.execute(`
          ALTER TABLE scanned_files
          ADD COLUMN is_duplicate BOOLEAN DEFAULT FALSE,
          ADD COLUMN duplicate_group_id INT,
          ADD INDEX idx_is_duplicate (is_duplicate),
          ADD INDEX idx_duplicate_group_id (duplicate_group_id)
        `);
        console.log('Added duplicate tracking columns');
      } catch (err) {
        // Ignore if columns already exist
        if (!err.message.includes('Duplicate column name') && !err.message.includes('already exists')) {
          console.warn(`Column addition warning: ${err.message}`);
        }
      }

      // Add folder_id column if it doesn't exist
      try {
        await this.connection.execute(`
          ALTER TABLE scanned_files
          ADD COLUMN folder_id VARCHAR(512),
          ADD INDEX idx_folder_id (folder_id)
        `);
        console.log('Added folder_id column for folder tracking');
      } catch (err) {
        // Ignore if column already exists
        if (!err.message.includes('Duplicate column name') && !err.message.includes('already exists')) {
          console.warn(`folder_id column addition warning: ${err.message}`);
        }
      }

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
      // Extract folder_id from path (directory containing the file)
      const pathSep = file.path.includes('/') ? '/' : '\\';
      const pathParts = file.path.split(pathSep);
      pathParts.pop(); // Remove filename
      const folder_id = pathParts.join(pathSep) || pathSep;
      
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
        scanId,
        folder_id
      ];
    });

    const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const flatValues = values.flat();

    await this.connection.execute(
      `INSERT INTO scanned_files 
       (path, name, size, hash, quick_hash, extension, mtime, atime, ctime, scan_id, folder_id)
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
   * Get all photos with metadata
   */
  async getPhotosWithMetadata(includeDuplicates = false) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    let query = `
      SELECT
        sf.id,
        sf.path,
        sf.name,
        sf.size,
        sf.hash,
        pm.width,
        pm.height,
        pm.format,
        pm.camera_make,
        pm.camera_model,
        pm.lens_model,
        pm.iso,
        pm.aperture,
        pm.shutter_speed,
        pm.focal_length,
        pm.flash,
        pm.date_taken,
        pm.latitude,
        pm.longitude,
        pm.altitude,
        pm.software,
        pm.artist,
        pm.copyright
      FROM scanned_files sf
      JOIN photo_metadata pm ON sf.id = pm.file_id
    `;

    // Hide duplicates by default (only show first occurrence by path)
    if (!includeDuplicates) {
      query += ` WHERE sf.is_duplicate = FALSE`;
    }

    query += ` ORDER BY pm.date_taken DESC`;

    const [rows] = await this.connection.query(query);

    return rows;
  }

  /**
   * Get all music tracks with metadata
   */
  async getMusicWithMetadata(includeDuplicates = false) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    let query = `
      SELECT
        sf.id,
        sf.path,
        sf.name,
        sf.size,
        sf.hash,
        sf.created_at,
        mm.title,
        mm.artist,
        mm.album,
        mm.album_artist,
        mm.year,
        mm.genre,
        mm.track_number,
        mm.track_total,
        mm.disk_number,
        mm.disk_total,
        mm.duration,
        mm.bitrate,
        mm.sample_rate,
        mm.channels,
        mm.codec,
        mm.composer,
        mm.isrc,
        mm.has_album_art
      FROM scanned_files sf
      JOIN music_metadata mm ON sf.id = mm.file_id
    `;

    // Hide duplicates by default (only show first occurrence by path)
    if (!includeDuplicates) {
      query += ` WHERE sf.is_duplicate = FALSE`;
    }

    query += ` ORDER BY mm.artist, mm.year, mm.album, mm.track_number`;

    const [rows] = await this.connection.query(query);

    return rows;
  }

  /**
   * Get all videos with metadata
   */
  async getVideosWithMetadata(includeDuplicates = false) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    let query = `
      SELECT
        sf.id,
        sf.path,
        sf.name,
        sf.size,
        sf.hash,
        sf.created_at,
        vm.title,
        vm.duration,
        vm.width,
        vm.height,
        vm.frame_rate,
        vm.video_codec,
        vm.video_bitrate,
        vm.audio_codec,
        vm.audio_bitrate,
        vm.audio_sample_rate,
        vm.audio_channels,
        vm.description,
        vm.genre,
        vm.artist,
        vm.year,
        vm.create_date,
        vm.software,
        vm.latitude,
        vm.longitude
      FROM scanned_files sf
      JOIN video_metadata vm ON sf.id = vm.file_id
    `;

    // Hide duplicates by default (only show first occurrence by path)
    if (!includeDuplicates) {
      query += ` WHERE sf.is_duplicate = FALSE`;
    }

    query += ` ORDER BY vm.create_date DESC`;

    const [rows] = await this.connection.query(query);

    return rows;
  }

  /**
   * Mark duplicate records in scanned_files table based on path
   */
  async markDuplicateRecords() {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    console.log('Marking duplicate records based on path...');

    // First, reset all duplicate flags
    await this.connection.execute('UPDATE scanned_files SET is_duplicate = FALSE, duplicate_group_id = NULL');

    // Find duplicate paths and assign group IDs
    const [duplicatePaths] = await this.connection.execute(`
      SELECT folder_id , name, COUNT(*) as count, GROUP_CONCAT(id ORDER BY id) as ids
      FROM scanned_files
      GROUP BY 	folder_id , name 
      HAVING count > 1
      ORDER BY count DESC
    `);

    console.log(`Found ${duplicatePaths.length} duplicate path groups`);

    let groupId = 1;
    for (const dup of duplicatePaths) {
      const ids = dup.ids.split(',').map(id => parseInt(id));
      const smallestId = Math.min(...ids);

      // Mark all records in this group except the smallest ID as duplicates
      // Create dynamic IN clause with proper placeholders
      const otherIds = ids.filter(id => id !== smallestId);
      if (otherIds.length > 0) {
        const placeholders = otherIds.map(() => '?').join(',');
        const sql = `UPDATE scanned_files SET is_duplicate = TRUE, duplicate_group_id = ? WHERE id IN (${placeholders})`;
        await this.connection.execute(sql, [smallestId, ...otherIds]);
        console.log(`Marked ${otherIds.length} records (excluding smallest ID ${smallestId}) for path "${dup.folder_id}" as duplicates (group ${groupId})`);
      } else {
        console.log(`No additional records to mark for path "${dup.path}" (only one record)`);
      }

      groupId++;
    }

    console.log(`Completed marking ${duplicatePaths.length} duplicate groups`);
    return duplicatePaths.length;
  }

  /**
   * Create or update user from Google OAuth
   */
  async createOrUpdateUser(googleId, email, name, picture) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    await this.connection.execute(`
      INSERT INTO users (google_id, email, name, picture, last_login)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE 
        email = VALUES(email),
        name = VALUES(name),
        picture = VALUES(picture),
        last_login = CURRENT_TIMESTAMP
    `, [googleId, email, name, picture]);

    const [rows] = await this.connection.execute(
      'SELECT id, google_id, email, name, picture FROM users WHERE google_id = ?',
      [googleId]
    );

    return rows[0];
  }

  /**
   * Get user by Google ID
   */
  async getUserByGoogleId(googleId) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      'SELECT id, google_id, email, name, picture FROM users WHERE google_id = ?',
      [googleId]
    );

    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Set or update rating for a music track
   */
  async setMusicRating(fileId, rating, userId = null) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    if (rating < 1 || rating > 5) {
      throw new Error('Rating must be between 1 and 5');
    }

    await this.connection.execute(`
      INSERT INTO music_ratings (file_id, user_id, rating)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE rating = ?, updated_at = CURRENT_TIMESTAMP
    `, [fileId, userId, rating, rating]);

    return { success: true, fileId, rating, userId };
  }

  /**
   * Get rating for a music track
   */
  async getMusicRating(fileId) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      'SELECT rating, updated_at FROM music_ratings WHERE file_id = ?',
      [fileId]
    );

    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Get all ratings (for batch loading)
   */
  async getAllMusicRatings() {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      'SELECT file_id, rating FROM music_ratings'
    );

    return rows;
  }

  /**
   * Record a play event for a music track
   */
  async recordMusicPlay(fileId, userId = null) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    await this.connection.execute(
      'INSERT INTO music_play_history (file_id, user_id) VALUES (?, ?)',
      [fileId, userId]
    );

    return { success: true, fileId, userId };
  }

  /**
   * Get play history for a track
   */
  async getMusicPlayHistory(fileId, limit = 10) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      'SELECT played_at FROM music_play_history WHERE file_id = ? ORDER BY played_at DESC LIMIT ?',
      [fileId, limit]
    );

    return rows;
  }

  /**
   * Get play count for a track
   */
  async getMusicPlayCount(fileId) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      'SELECT COUNT(*) as count FROM music_play_history WHERE file_id = ?',
      [fileId]
    );

    return rows[0].count;
  }

  /**
   * Get all play counts (for batch loading)
   */
  async getAllMusicPlayCounts() {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(`
      SELECT file_id, COUNT(*) as play_count, MAX(played_at) as last_played
      FROM music_play_history
      GROUP BY file_id
    `);

    return rows;
  }

  /**
   * Get user-specific play history
   */
  async getUserPlayHistory(userId, limit = 50) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(`
      SELECT mph.file_id, mph.played_at, sf.name, sf.path
      FROM music_play_history mph
      JOIN scanned_files sf ON mph.file_id = sf.id
      WHERE mph.user_id = ?
      ORDER BY mph.played_at DESC
      LIMIT ?
    `, [userId, limit]);

    return rows;
  }

  /**
   * Get user-specific ratings
   */
  async getUserRatings(userId) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      'SELECT file_id, rating, updated_at FROM music_ratings WHERE user_id = ?',
      [userId]
    );

    return rows;
  }

  /**
   * Get rating for a track by specific user
   */
  async getUserTrackRating(fileId, userId) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      'SELECT rating, updated_at FROM music_ratings WHERE file_id = ? AND user_id = ?',
      [fileId, userId]
    );

    return rows.length > 0 ? rows[0] : null;
  }
}
