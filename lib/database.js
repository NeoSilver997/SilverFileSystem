import mysql from 'mysql2/promise';

/**
 * Database Manager for storing scanned file information
 * Uses a connection pool with automatic reconnection
 */
export class DatabaseManager {
  constructor(config = {}) {
    this.config = {
      host: config.host || process.env.DB_HOST || 'localhost',
      port: config.port || process.env.DB_PORT || 3306,
      user: config.user || process.env.DB_USER || 'root',
      password: config.password || process.env.DB_PASSWORD || '',
      database: config.database || process.env.DB_NAME || 'silverfilesystem',
      waitForConnections: true,
      connectionLimit: 10,
      maxIdle: 10,
      idleTimeout: 60000,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      ...config
    };
    this.pool = null;
  }

  get connection() {
    return this.pool;
  }

  set connection(val) {
    if (this.pool) {
      this.pool.end().catch(() => {});
    }
    this.pool = val;
  }

  /**
   * Connect to the MySQL database using a connection pool
   */
  async connect() {
    try {
      this.pool = mysql.createPool(this.config);
      const conn = await this.pool.getConnection();
      console.log('Connected to MySQL database (pool)');
      conn.release();
    } catch (err) {
      throw new Error(`Failed to connect to database: ${err.message}`);
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * Create the database version table
   */
  async createVersionTable() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS db_version (
        id INT AUTO_INCREMENT PRIMARY KEY,
        version INT NOT NULL UNIQUE,
        description VARCHAR(255),
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_version (version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  /**
   * Get the current database version
   */
  async getCurrentVersion() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      const [rows] = await this.connection.execute(
        'SELECT MAX(version) as version FROM db_version'
      );
      return rows[0].version || 0;
    } catch (err) {
      // If table doesn't exist, return 0
      if (err.message.includes("doesn't exist")) {
        return 0;
      }
      throw err;
    }
  }

  /**
   * Set the database version
   */
  async setVersion(version, description = '') {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    await this.connection.execute(
      'INSERT INTO db_version (version, description) VALUES (?, ?)',
      [version, description]
    );
  }

  /**
   * Check if a specific migration version has been applied
   */
  async isMigrationApplied(version) {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      const [rows] = await this.connection.execute(
        'SELECT COUNT(*) as count FROM db_version WHERE version = ?',
        [version]
      );
      return rows[0].count > 0;
    } catch (err) {
      // If table doesn't exist, no migrations have been applied
      if (err.message.includes("doesn't exist")) {
        return false;
      }
      throw err;
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
      // Create version table first
      await this.createVersionTable();
      
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
          username VARCHAR(255) NOT NULL UNIQUE,
          password_hash VARCHAR(255),
          email VARCHAR(255),
          google_id VARCHAR(255),
          profile_picture VARCHAR(512),
          auth_provider ENUM('local', 'google') DEFAULT 'local',
          is_enabled BOOLEAN DEFAULT FALSE,
          is_admin BOOLEAN DEFAULT FALSE,
          can_view_photos BOOLEAN DEFAULT TRUE,
          can_view_music BOOLEAN DEFAULT TRUE,
          can_view_videos BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_username (username),
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
      
      // Create drive_usage_history table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS drive_usage_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          drive VARCHAR(10) NOT NULL,
          total_bytes BIGINT NOT NULL,
          used_bytes BIGINT NOT NULL,
          free_bytes BIGINT NOT NULL,
          recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_drive (drive),
          INDEX idx_recorded_at (recorded_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      // Create deleted_files_archive table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS deleted_files_archive (
          id INT AUTO_INCREMENT PRIMARY KEY,
          original_id INT,
          name VARCHAR(512) NOT NULL,
          path VARCHAR(2048),
          size BIGINT,
          hash VARCHAR(64),
          extension VARCHAR(255),
          deleted_by VARCHAR(100) DEFAULT 'system',
          deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_deleted_at (deleted_at),
          INDEX idx_name (name(255)),
          INDEX idx_hash (hash)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      // Set initial version if not already set
      const currentVersion = await this.getCurrentVersion();
      if (currentVersion === 0) {
        await this.setVersion(1, 'Initial schema with all base tables');
        console.log('Database version set to 1');
      }
    } catch (err) {
      throw new Error(`Failed to initialize tables: ${err.message}`);
    }
  }

  /**
   * Migration: Version 2 - Update extension column and add duplicate tracking
   */
  async migrateToVersion2() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    console.log('Applying migration to version 2...');

    // Update extension column to support longer extensions
    await this.connection.execute(`
      ALTER TABLE scanned_files
      MODIFY COLUMN extension VARCHAR(255)
    `);
    console.log('Updated extension column size');

    // Add duplicate tracking columns
    await this.connection.execute(`
      ALTER TABLE scanned_files
      ADD COLUMN is_duplicate BOOLEAN DEFAULT FALSE,
      ADD COLUMN duplicate_group_id INT,
      ADD INDEX idx_is_duplicate (is_duplicate),
      ADD INDEX idx_duplicate_group_id (duplicate_group_id)
    `);
    console.log('Added duplicate tracking columns');

    await this.setVersion(2, 'Updated extension column and added duplicate tracking');
    console.log('Migration to version 2 completed');
  }

  /**
   * Migration: Version 3 - Add folder_id column
   */
  async migrateToVersion3() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    console.log('Applying migration to version 3...');

    // Add folder_id column
    await this.connection.execute(`
      ALTER TABLE scanned_files
      ADD COLUMN folder_id VARCHAR(512),
      ADD INDEX idx_folder_id (folder_id)
    `);
    console.log('Added folder_id column for folder tracking');

    await this.setVersion(3, 'Added folder_id column for normalized folder tracking');
    console.log('Migration to version 3 completed');
  }

  /**
   * Migration: Version 4 - Add thumbnail cache table
   */
  async migrateToVersion4() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    console.log('Applying migration to version 4...');

    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS thumbnail_cache (
        id INT AUTO_INCREMENT PRIMARY KEY,
        file_id INT NOT NULL,
        media_type ENUM('image', 'video') NOT NULL,
        thumb_data LONGBLOB NOT NULL,
        content_type VARCHAR(50) NOT NULL DEFAULT 'image/jpeg',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_thumb (file_id, media_type),
        INDEX idx_file_id (file_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.setVersion(4, 'Added thumbnail cache table');
    console.log('Migration to version 4 completed');
  }

  /**
   * Migration: Version 5 - Add folder_tree table
   */
  async migrateToVersion5() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    console.log('Applying migration to version 5...');

    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS folder_tree (
        id INT AUTO_INCREMENT PRIMARY KEY,
        folder_id VARCHAR(2048) NOT NULL,
        parent_id INT DEFAULT NULL,
        folder_name VARCHAR(512) NOT NULL,
        file_count INT NOT NULL DEFAULT 0,
        total_size BIGINT NOT NULL DEFAULT 0,
        recursive_count INT NOT NULL DEFAULT 0,
        recursive_size BIGINT NOT NULL DEFAULT 0,
        depth INT NOT NULL DEFAULT 0,
        hidden TINYINT(1) NOT NULL DEFAULT 0,
        remark VARCHAR(256) DEFAULT NULL,
        related_folder_id INT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_folder_id (folder_id(100)),
        INDEX idx_parent_id (parent_id),
        INDEX idx_depth (depth),
        INDEX idx_size (total_size DESC),
        INDEX idx_hidden (hidden),
        INDEX idx_related_folder (related_folder_id),
        CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES folder_tree(id) ON DELETE SET NULL,
        CONSTRAINT fk_related FOREIGN KEY (related_folder_id) REFERENCES folder_tree(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.setVersion(5, 'Added folder_tree table');
    console.log('Migration to version 5 completed');
  }

  /**
   * Migration: Version 6 - Add camera_owners table
   */
  async migrateToVersion6() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    console.log('Applying migration to version 6...');

    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS camera_owners (
        id INT AUTO_INCREMENT PRIMARY KEY,
        camera_make VARCHAR(255) NOT NULL,
        camera_model VARCHAR(255) NOT NULL,
        owner VARCHAR(255) DEFAULT NULL,
        custom_name VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_camera (camera_make, camera_model),
        INDEX idx_owner (owner)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.setVersion(6, 'Added camera_owners table');
    console.log('Migration to version 6 completed');
  }

  /**
   * Migration: Version 7 - Add photo_classifications table for VLM-based photo categorization
   */
  async migrateToVersion7() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    console.log('Applying migration to version 7...');

    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS photo_classifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        file_id INT NOT NULL,
        category ENUM('人物單人','人物合照','風景','動物','食物','收據餐牌資料','螢幕截圖','其他') NOT NULL,
        description TEXT,
        has_text BOOLEAN DEFAULT FALSE,
        persons INT DEFAULT 0,
        confidence DECIMAL(3,2) DEFAULT 0.50,
        original_path VARCHAR(2048) NOT NULL,
        destination_path VARCHAR(2048),
        compressed BOOLEAN DEFAULT FALSE,
        original_size BIGINT,
        final_size BIGINT,
        vlm_model VARCHAR(255),
        vlm_raw_response TEXT,
        classified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME DEFAULT NULL,
        FOREIGN KEY (file_id) REFERENCES scanned_files(id) ON DELETE CASCADE,
        INDEX idx_file_id (file_id),
        INDEX idx_category (category),
        INDEX idx_classified_at (classified_at),
        INDEX idx_expires_at (expires_at),
        INDEX idx_destination (destination_path(255))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS vlm_processing_queue (
        id INT AUTO_INCREMENT PRIMARY KEY,
        file_id INT NOT NULL,
        status ENUM('pending','processing','completed','failed') DEFAULT 'pending',
        error_message TEXT,
        attempts INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME DEFAULT NULL,
        completed_at DATETIME DEFAULT NULL,
        FOREIGN KEY (file_id) REFERENCES scanned_files(id) ON DELETE CASCADE,
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.setVersion(7, 'Added photo_classifications and vlm_processing_queue tables');
    console.log('Migration to version 7 completed');
  }

  /**
   * Migration: Version 8 - Add detailed vision analysis columns to photo_classifications
   */
  async migrateToVersion8() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    console.log('Applying migration to version 8...');

    const columns = [
      { name: 'subject',           type: 'TEXT' },
      { name: 'action',            type: 'TEXT' },
      { name: 'background_desc',   type: 'TEXT' },
      { name: 'style_desc',        type: 'TEXT' },
      { name: 'ai_prompt',         type: 'TEXT' },
      { name: 'tags',              type: 'TEXT' },
      { name: 'mood',              type: 'VARCHAR(512)' },
      { name: 'color_palette',     type: 'VARCHAR(512)' },
      { name: 'lighting',          type: 'VARCHAR(512)' },
      { name: 'camera_angle',      type: 'VARCHAR(255)' }
    ];

    for (const col of columns) {
      try {
        await this.connection.execute(
          `ALTER TABLE photo_classifications ADD COLUMN ${col.name} ${col.type}`
        );
        console.log(`  Added column: ${col.name}`);
      } catch (err) {
        if (!this.isMigrationAlreadyAppliedError(err)) throw err;
      }
    }

    await this.connection.execute(`
      CREATE INDEX idx_tags ON photo_classifications(tags(100))
    `).catch(() => {});

    await this.setVersion(8, 'Added detailed vision analysis columns to photo_classifications');
    console.log('Migration to version 8 completed');
  }

  /**
   * Migration: Version 9 - Add face detection tables
   */
  async migrateToVersion9() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    console.log('Applying migration to version 9...');

    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS detected_faces (
        id INT AUTO_INCREMENT PRIMARY KEY,
        file_id INT NOT NULL,
        face_index INT NOT NULL DEFAULT 0,
        confidence DECIMAL(3,2) NOT NULL,
        bbox_x INT NOT NULL,
        bbox_y INT NOT NULL,
        bbox_width INT NOT NULL,
        bbox_height INT NOT NULL,
        gender ENUM('male','female') DEFAULT NULL,
        age INT DEFAULT NULL,
        expression VARCHAR(50) DEFAULT NULL,
        expression_confidence DECIMAL(3,2) DEFAULT NULL,
        all_expressions JSON DEFAULT NULL,
        face_descriptor JSON DEFAULT NULL,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (file_id) REFERENCES scanned_files(id) ON DELETE CASCADE,
        INDEX idx_file_id (file_id),
        INDEX idx_gender (gender),
        INDEX idx_age (age),
        INDEX idx_expression (expression),
        INDEX idx_file_face (file_id, face_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS face_groups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        label VARCHAR(255) DEFAULT NULL,
        person_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_label (label)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS face_group_members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id INT NOT NULL,
        face_id INT NOT NULL,
        similarity DECIMAL(5,4) DEFAULT NULL,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES face_groups(id) ON DELETE CASCADE,
        FOREIGN KEY (face_id) REFERENCES detected_faces(id) ON DELETE CASCADE,
        UNIQUE KEY unique_group_face (group_id, face_id),
        INDEX idx_group_id (group_id),
        INDEX idx_face_id (face_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS photo_faces_summary (
        id INT AUTO_INCREMENT PRIMARY KEY,
        file_id INT NOT NULL,
        face_count INT DEFAULT 0,
        has_faces BOOLEAN DEFAULT FALSE,
        male_count INT DEFAULT 0,
        female_count INT DEFAULT 0,
        avg_age DECIMAL(4,1) DEFAULT NULL,
        dominant_expression VARCHAR(50) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (file_id) REFERENCES scanned_files(id) ON DELETE CASCADE,
        UNIQUE KEY unique_file_summary (file_id),
        INDEX idx_has_faces (has_faces),
        INDEX idx_face_count (face_count)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.setVersion(9, 'Added face detection tables');
    console.log('Migration to version 9 completed');
  }

  /**
   * Migration: Version 10 - Add face_group_id to detected_faces for persistent naming
   */
  async migrateToVersion10() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    console.log('Applying migration to version 10...');

    try {
      await this.connection.execute(`
        ALTER TABLE detected_faces ADD COLUMN face_group_id INT DEFAULT NULL
      `);
      console.log('  Added face_group_id column');
    } catch (err) {
      if (!this.isMigrationAlreadyAppliedError(err)) throw err;
    }

    try {
      await this.connection.execute(`
        ALTER TABLE face_groups ADD COLUMN face_count INT DEFAULT 0
      `);
      console.log('  Added face_count to face_groups');
    } catch (err) {
      if (!this.isMigrationAlreadyAppliedError(err)) throw err;
    }

    await this.setVersion(10, 'Added face_group_id to detected_faces');
    console.log('Migration to version 10 completed');
  }

  /**
   * Helper method to check if migration should be skipped due to existing schema
   */
  isMigrationAlreadyAppliedError(err) {
    return err.message.includes('Duplicate column name') || 
           err.message.includes('already exists') ||
           err.message.includes('duplicate key');
  }

  /**
   * Get version history
   */
  async getVersionHistory() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      const [rows] = await this.connection.execute(
        'SELECT version, description, applied_at FROM db_version ORDER BY version'
      );
      return rows;
    } catch (err) {
      // If table doesn't exist, return empty array
      if (err.message.includes("doesn't exist")) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Update database schema to latest version
   * Uses version tracking to apply only necessary migrations
   */
  async updateSchema() {
    if (!this.connection) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      // Ensure version table exists
      await this.createVersionTable();

      // Get current version
      const currentVersion = await this.getCurrentVersion();
      console.log(`Current database version: ${currentVersion}`);

      // Apply migrations in order
      if (currentVersion < 2) {
        try {
          await this.migrateToVersion2();
        } catch (err) {
          // If migration fails because columns already exist, mark as applied
          if (this.isMigrationAlreadyAppliedError(err)) {
            console.log('Version 2 changes already exist, marking as applied');
            await this.setVersion(2, 'Updated extension column and added duplicate tracking');
          } else {
            throw err;
          }
        }
      }

      if (currentVersion < 3) {
        try {
          await this.migrateToVersion3();
        } catch (err) {
          // If migration fails because column already exists, mark as applied
          if (this.isMigrationAlreadyAppliedError(err)) {
            console.log('Version 3 changes already exist, marking as applied');
            await this.setVersion(3, 'Added folder_id column for normalized folder tracking');
          } else {
            throw err;
          }
        }
      }

      if (currentVersion < 4) {
        try {
          await this.migrateToVersion4();
        } catch (err) {
          if (this.isMigrationAlreadyAppliedError(err)) {
            console.log('Version 4 changes already exist, marking as applied');
            await this.setVersion(4, 'Added thumbnail cache table');
          } else {
            throw err;
          }
        }
      }

      if (currentVersion < 5) {
        try {
          await this.migrateToVersion5();
        } catch (err) {
          if (this.isMigrationAlreadyAppliedError(err)) {
            console.log('Version 5 changes already exist, marking as applied');
            await this.setVersion(5, 'Added folder_tree table');
          } else {
            throw err;
          }
        }
      }

      if (currentVersion < 6) {
        try {
          await this.migrateToVersion6();
        } catch (err) {
          if (this.isMigrationAlreadyAppliedError(err)) {
            console.log('Version 6 changes already exist, marking as applied');
            await this.setVersion(6, 'Added camera_owners table');
          } else {
            throw err;
          }
        }
      }

      if (currentVersion < 7) {
        try {
          await this.migrateToVersion7();
        } catch (err) {
          if (this.isMigrationAlreadyAppliedError(err)) {
            console.log('Version 7 changes already exist, marking as applied');
            await this.setVersion(7, 'Added photo_classifications and vlm_processing_queue tables');
          } else {
            throw err;
          }
        }
      }

      if (currentVersion < 8) {
        try {
          await this.migrateToVersion8();
        } catch (err) {
          if (this.isMigrationAlreadyAppliedError(err)) {
            console.log('Version 8 changes already exist, marking as applied');
            await this.setVersion(8, 'Added detailed vision analysis columns to photo_classifications');
          } else {
            throw err;
          }
        }
      }

      if (currentVersion < 9) {
        try {
          await this.migrateToVersion9();
        } catch (err) {
          if (this.isMigrationAlreadyAppliedError(err)) {
            console.log('Version 9 changes already exist, marking as applied');
            await this.setVersion(9, 'Added face detection tables');
          } else {
            throw err;
          }
        }
      }

      if (currentVersion < 10) {
        try {
          await this.migrateToVersion10();
        } catch (err) {
          if (this.isMigrationAlreadyAppliedError(err)) {
            console.log('Version 10 changes already exist, marking as applied');
            await this.setVersion(10, 'Added face_group_id to detected_faces');
          } else {
            throw err;
          }
        }
      }

      const newVersion = await this.getCurrentVersion();
      console.log(`Database schema updated to version ${newVersion}`);
    } catch (err) {
      throw new Error(`Failed to update schema: ${err.message}`);
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
    
    // Compute folder_id_int from path
    let folderIdInt = null;
    if (file.path) {
      const pathSep = file.path.includes('/') ? '/' : '\\';
      const pathParts = file.path.split(pathSep);
      pathParts.pop();
      const folderId = pathParts.join(pathSep) || pathSep;
      const [ftRow] = await this.connection.query('SELECT id FROM folder_tree WHERE folder_id = ?', [folderId]);
      if (ftRow.length > 0) folderIdInt = ftRow[0].id;
    }

    const [result] = await this.connection.execute(
      `INSERT INTO scanned_files 
       (name, size, hash, quick_hash, extension, mtime, atime, ctime, scan_id, folder_id_int)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        file.name,
        file.size,
        file.hash || null,
        file.quickHash || null,
        extension,
        file.mtime,
        file.atime,
        file.ctime,
        scanId,
        folderIdInt
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

    // Compute folder_id_int for each file
    const folderIdMap = new Map(); // path -> folder_id_int
    const uniqueFolderPaths = new Set();
    for (const file of files) {
      if (file.path) {
        const pathSep = file.path.includes('/') ? '/' : '\\';
        const pathParts = file.path.split(pathSep);
        pathParts.pop();
        const folderId = pathParts.join(pathSep) || pathSep;
        uniqueFolderPaths.add(folderId);
      }
    }
    
    // Lookup folder_tree IDs
    if (uniqueFolderPaths.size > 0) {
      const folderArr = [...uniqueFolderPaths];
      const BATCH = 1000;
      for (let i = 0; i < folderArr.length; i += BATCH) {
        const batch = folderArr.slice(i, i + BATCH);
        const ph = batch.map(() => '?').join(',');
        const [ftRows] = await this.connection.query(
          `SELECT id, folder_id FROM folder_tree WHERE folder_id IN (${ph})`,
          batch
        );
        for (const r of ftRows) folderIdMap.set(r.folder_id, r.id);
      }
    }

    // Filter out files that already exist (by name + folder_id_int)
    const BATCH2 = 1000;
    const existingKeys = new Set();
    for (let i = 0; i < files.length; i += BATCH2) {
      const chunk = files.slice(i, i + BATCH2);
      const nameIdPairs = chunk.map(f => {
        const pathSep = f.path.includes('/') ? '/' : '\\';
        const pathParts = f.path.split(pathSep);
        pathParts.pop();
        const folderId = pathParts.join(pathSep) || pathSep;
        const fid = folderIdMap.get(folderId) || null;
        return [f.name, fid];
      });
      for (const [name, fid] of nameIdPairs) {
        if (fid) {
          const [rows] = await this.connection.query(
            'SELECT id FROM scanned_files WHERE name = ? AND folder_id_int = ? LIMIT 1',
            [name, fid]
          );
          if (rows.length > 0) existingKeys.add(`${name}_${fid}`);
        }
      }
    }

    const newFiles = files.filter(f => {
      const pathSep = f.path.includes('/') ? '/' : '\\';
      const pathParts = f.path.split(pathSep);
      pathParts.pop();
      const folderId = pathParts.join(pathSep) || pathSep;
      const fid = folderIdMap.get(folderId) || null;
      return !existingKeys.has(`${f.name}_${fid}`);
    });
    if (newFiles.length === 0) return;

    const values = newFiles.map(file => {
      const extension = this.getFileExtension(file.name);
      const pathSep = file.path.includes('/') ? '/' : '\\';
      const pathParts = file.path.split(pathSep);
      pathParts.pop();
      const folderId = pathParts.join(pathSep) || pathSep;
      const folderIdInt = folderIdMap.get(folderId) || null;
      
      return [
        file.name,
        file.size,
        file.hash || null,
        file.quickHash || null,
        extension,
        file.mtime,
        file.atime,
        file.ctime,
        scanId,
        folderIdInt
      ];
    });

    const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const flatValues = values.flat();

    await this.connection.execute(
      `INSERT INTO scanned_files 
       (name, size, hash, quick_hash, extension, mtime, atime, ctime, scan_id, folder_id_int)
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
   * Store photo classification result from VLM (with detailed vision analysis)
   */
  async storePhotoClassification(fileId, classification, result) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const expiresAt = ['收據餐牌資料', '螢幕截圖'].includes(classification.category)
      ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
      : null;

    const tagsJson = Array.isArray(classification.tags)
      ? JSON.stringify(classification.tags)
      : null;

    await this.connection.execute(
      `INSERT INTO photo_classifications
       (file_id, category, description, has_text, persons, confidence,
        original_path, destination_path, compressed, original_size, final_size,
        vlm_model, vlm_raw_response, expires_at,
        subject, action, background_desc, style_desc, ai_prompt, tags,
        mood, color_palette, lighting, camera_angle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fileId,
        classification.category,
        this.sanitizeForDb(classification.description || classification.subject || ''),
        classification.has_text ? 1 : 0,
        classification.persons || 0,
        classification.confidence || 0.5,
        this.sanitizeForDb(result.originalPath),
        this.sanitizeForDb(result.destinationPath),
        result.compressed ? 1 : 0,
        result.originalSize || null,
        result.finalSize || null,
        this.sanitizeForDb(result.model),
        this.sanitizeForDb(result.rawResponse),
        expiresAt,
        this.sanitizeForDb(classification.subject || ''),
        this.sanitizeForDb(classification.action || ''),
        this.sanitizeForDb(classification.background || ''),
        this.sanitizeForDb(classification.style || ''),
        this.sanitizeForDb(classification.ai_prompt || ''),
        this.sanitizeForDb(tagsJson),
        this.sanitizeForDb(classification.mood || ''),
        this.sanitizeForDb(classification.color_palette || ''),
        this.sanitizeForDb(classification.lighting || ''),
        this.sanitizeForDb(classification.camera_angle || '')
      ]
    );
  }

  /**
   * Get photo classifications with optional filters (including detailed vision fields)
   */
  async getPhotoClassifications(filters = {}) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    let query = 'SELECT pc.*, sf.name, sf.size, sf.extension FROM photo_classifications pc JOIN scanned_files sf ON pc.file_id = sf.id';
    const conditions = [];
    const params = [];

    if (filters.category) {
      conditions.push('pc.category = ?');
      params.push(filters.category);
    }
    if (filters.hasText !== undefined) {
      conditions.push('pc.has_text = ?');
      params.push(filters.hasText ? 1 : 0);
    }
    if (filters.minConfidence) {
      conditions.push('pc.confidence >= ?');
      params.push(filters.minConfidence);
    }
    if (filters.since) {
      conditions.push('pc.classified_at >= ?');
      params.push(filters.since);
    }
    if (filters.tag) {
      conditions.push('pc.tags LIKE ?');
      params.push(`%"${filters.tag}"%`);
    }
    if (filters.mood) {
      conditions.push('pc.mood LIKE ?');
      params.push(`%${filters.mood}%`);
    }
    if (filters.style) {
      conditions.push('pc.style_desc LIKE ?');
      params.push(`%${filters.style}%`);
    }
    if (filters.search) {
      conditions.push('(pc.subject LIKE ? OR pc.action LIKE ? OR pc.background_desc LIKE ? OR pc.ai_prompt LIKE ? OR pc.tags LIKE ?)');
      const term = `%${filters.search}%`;
      params.push(term, term, term, term, term);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY pc.classified_at DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const [rows] = await this.connection.execute(query, params);
    return rows;
  }

  /**
   * Search photos by AI-generated prompt content
   */
  async searchByPrompt(keyword) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      `SELECT pc.*, sf.name, sf.size, sf.extension
       FROM photo_classifications pc
       JOIN scanned_files sf ON pc.file_id = sf.id
       WHERE pc.ai_prompt LIKE ? OR pc.tags LIKE ? OR pc.subject LIKE ?
       ORDER BY pc.confidence DESC
       LIMIT 50`,
      [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`]
    );
    return rows;
  }

  /**
   * Get all unique tags across classifications
   */
  async getAllTags() {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      'SELECT tags FROM photo_classifications WHERE tags IS NOT NULL AND tags != \'\''
    );

    const tagCount = {};
    for (const row of rows) {
      try {
        const tags = JSON.parse(row.tags);
        if (Array.isArray(tags)) {
          for (const tag of tags) {
            tagCount[tag] = (tagCount[tag] || 0) + 1;
          }
        }
      } catch {}
    }

    return Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));
  }

  /**
   * Get classification statistics
   */
  async getClassificationStats() {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(`
      SELECT category, COUNT(*) as count, AVG(confidence) as avg_confidence,
             SUM(CASE WHEN compressed THEN 1 ELSE 0 END) as compressed_count
      FROM photo_classifications
      GROUP BY category
      ORDER BY count DESC
    `);

    const [total] = await this.connection.execute(
      'SELECT COUNT(*) as total, SUM(original_size) as total_original_size, SUM(final_size) as total_final_size FROM photo_classifications'
    );

    return { categories: rows, total: total[0] };
  }

  // ─── Face Detection Methods ───────────────────────────────────────────────

  /**
   * Store detected faces for a photo
   */
  async storeDetectedFaces(fileId, faceResult) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const { faces, summary } = faceResult;

    await this.connection.execute(
      `INSERT INTO photo_faces_summary (file_id, face_count, has_faces, male_count, female_count, avg_age, dominant_expression)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         face_count = VALUES(face_count), has_faces = VALUES(has_faces),
         male_count = VALUES(male_count), female_count = VALUES(female_count),
         avg_age = VALUES(avg_age), dominant_expression = VALUES(dominant_expression)`,
      [
        fileId,
        summary.faceCount,
        summary.hasFaces ? 1 : 0,
        faces.filter(f => f.gender === 'male').length,
        faces.filter(f => f.gender === 'female').length,
        summary.averageAge || null,
        faces.length > 0 ? (faces[0].expression || null) : null
      ]
    );

    for (const face of faces) {
      const hasThumb = !!face.thumbnail;
      const descriptor = hasThumb ? JSON.stringify({ thumbnail: face.thumbnail, phash: face.perceptual_hash, has_glasses: face.has_glasses, age_group: face.age_group }) : null;
      await this.connection.execute(
        `INSERT INTO detected_faces
         (file_id, face_index, confidence, bbox_x, bbox_y, bbox_width, bbox_height,
          gender, age, expression, expression_confidence, all_expressions, face_descriptor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fileId,
          face.index || 0,
          face.confidence || 0.5,
          face.bbox?.x || 0,
          face.bbox?.y || 0,
          face.bbox?.width || 0,
          face.bbox?.height || 0,
          face.gender === 'male' || face.gender === 'female' ? face.gender : null,
          face.age_approx || null,
          face.expression || null,
          face.expression_confidence || null,
          null,
          descriptor
        ]
      );
    }
  }

  /**
   * Get face summary for a photo
   */
  async getPhotoFaceSummary(fileId) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [summary] = await this.connection.execute(
      'SELECT * FROM photo_faces_summary WHERE file_id = ?', [fileId]
    );

    const [faces] = await this.connection.execute(
      'SELECT * FROM detected_faces WHERE file_id = ? ORDER BY face_index', [fileId]
    );

    return {
      summary: summary[0] || null,
      faces: faces.map(f => ({
        ...f,
        all_expressions: f.all_expressions ? JSON.parse(f.all_expressions) : null,
        face_descriptor: f.face_descriptor ? JSON.parse(f.face_descriptor) : null
      }))
    };
  }

  /**
   * Get all photos with faces, with optional filters
   */
  async getPhotosWithFaces(filters = {}) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    let query = `
      SELECT pfs.*, sf.name, sf.size, sf.extension, sf.path
      FROM photo_faces_summary pfs
      JOIN scanned_files sf ON pfs.file_id = sf.id
      WHERE pfs.has_faces = 1
    `;
    const params = [];

    if (filters.gender) {
      if (filters.gender === 'male') {
        query += ' AND pfs.male_count > 0';
      } else if (filters.gender === 'female') {
        query += ' AND pfs.female_count > 0';
      }
    }

    if (filters.minFaces) {
      query += ' AND pfs.face_count >= ?';
      params.push(filters.minFaces);
    }

    if (filters.maxAge) {
      query += ' AND pfs.avg_age <= ?';
      params.push(filters.maxAge);
    }

    if (filters.minAge) {
      query += ' AND pfs.avg_age >= ?';
      params.push(filters.minAge);
    }

    query += ' ORDER BY pfs.face_count DESC, sf.name';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const [rows] = await this.connection.execute(query, params);
    return rows;
  }

  /**
   * Get face statistics across all photos
   */
  async getFaceStats() {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [totalFaces] = await this.connection.execute(
      'SELECT COUNT(*) as total, SUM(has_faces) as photos_with_faces FROM photo_faces_summary'
    );

    const [genderStats] = await this.connection.execute(`
      SELECT gender, COUNT(*) as count, AVG(age) as avg_age
      FROM detected_faces
      WHERE gender IS NOT NULL
      GROUP BY gender
    `);

    const [expressionStats] = await this.connection.execute(`
      SELECT expression, COUNT(*) as count
      FROM detected_faces
      WHERE expression IS NOT NULL
      GROUP BY expression
      ORDER BY count DESC
    `);

    const [ageDistribution] = await this.connection.execute(`
      SELECT
        CASE
          WHEN age < 13 THEN 'child'
          WHEN age < 18 THEN 'teen'
          WHEN age < 30 THEN 'young'
          WHEN age < 55 THEN 'adult'
          ELSE 'senior'
        END as age_group,
        COUNT(*) as count
      FROM detected_faces
      WHERE age IS NOT NULL
      GROUP BY age_group
    `);

    return {
      total: totalFaces[0],
      byGender: genderStats,
      byExpression: expressionStats,
      byAgeGroup: ageDistribution
    };
  }

  /**
   * Enqueue file for VLM processing
   */
  async enqueueForVLM(fileId) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [existing] = await this.connection.execute(
      'SELECT id FROM vlm_processing_queue WHERE file_id = ? AND status IN (?, ?)',
      [fileId, 'pending', 'processing']
    );

    if (existing.length > 0) {
      return existing[0].id;
    }

    const [result] = await this.connection.execute(
      'INSERT INTO vlm_processing_queue (file_id) VALUES (?)',
      [fileId]
    );

    return result.insertId;
  }

  /**
   * Get next pending items from VLM queue
   */
  async getPendingVLMItems(limit = 10) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const [rows] = await this.connection.execute(
      `SELECT q.id as queue_id, q.file_id, sf.path, sf.name
       FROM vlm_processing_queue q
       JOIN scanned_files sf ON q.file_id = sf.id
       WHERE q.status = 'pending'
       ORDER BY q.created_at ASC
       LIMIT ?`,
      [limit]
    );

    return rows;
  }

  /**
   * Update VLM queue item status
   */
  async updateVLMQueueStatus(queueId, status, errorMessage = null) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const updates = ['status = ?', 'attempts = attempts + 1'];
    const params = [status];

    if (status === 'processing') {
      updates.push('started_at = NOW()');
    }
    if (status === 'completed' || status === 'failed') {
      updates.push('completed_at = NOW()');
    }
    if (errorMessage) {
      updates.push('error_message = ?');
      params.push(errorMessage);
    }

    params.push(queueId);
    await this.connection.execute(
      `UPDATE vlm_processing_queue SET ${updates.join(', ')} WHERE id = ?`,
      params
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
    
    let query = `SELECT sf.id, CONCAT(ft.folder_id, '\\\\', sf.name) as path, sf.size FROM scanned_files sf LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
                 WHERE sf.hash IS NULL AND sf.size >= ${validMinSize}`;
    
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
      SELECT sf.id, CONCAT(ft.folder_id, '\\\\', sf.name) as path, sf.size 
      FROM scanned_files sf
      LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
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

    const validMinSize = (typeof minSize === 'number' && !isNaN(minSize)) ? minSize : 0;
    const validMaxSize = (maxSize && typeof maxSize === 'number' && maxSize > 0) ? maxSize : 0;

    let sizeFilter = `hash IS NULL AND size >= ${validMinSize}`;
    if (validMaxSize > 0) {
      sizeFilter += ` AND size <= ${validMaxSize}`;
    }

    let query = `
      SELECT sf.id, CONCAT(ft.folder_id, '\\\\', sf.name) as path, sf.size
      FROM scanned_files sf
      LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
      WHERE sf.hash IS NULL AND sf.size >= ${validMinSize}
    `;
    if (validMaxSize > 0) {
      query += ` AND sf.size <= ${validMaxSize}`;
    }
    query += `
      AND sf.size IN (
        SELECT size
        FROM scanned_files
        WHERE ${sizeFilter}
        GROUP BY size
        HAVING COUNT(*) > 1
      )
      ORDER BY sf.size DESC
    `;
    if (limit && typeof limit === 'number' && limit > 0) {
      query += ` LIMIT ${limit}`;
    }

    const [rows] = await this.connection.query(query);
    return rows;
  }

  /**
   * Update file hash and quick_hash in database
   */
  async updateFileHash(fileId, hash, quickHash = null) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }
    await this.connection.query(
      'UPDATE scanned_files SET hash = ?, quick_hash = ? WHERE id = ?',
      [hash, quickHash || hash, fileId]
    );
  }

  /**
   * Delete file record from database
   */
  async deleteFile(fileId) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }
    await this.connection.query('DELETE FROM scanned_files WHERE id = ?', [fileId]);
  }

  /**
   * Archive files before deletion
   */
  async archiveDeletedFiles(files, deletedBy = 'system') {
    if (!this.connection) {
      throw new Error('Database not connected');
    }
    if (files.length === 0) return 0;
    const BATCH = 500;
    let archived = 0;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const values = batch.map(f => [
        f.id || null, f.name, f.path || null, f.size || null,
        f.hash || null, f.extension || null, deletedBy
      ]);
      const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
      const flat = values.flat();
      await this.connection.query(
        `INSERT INTO deleted_files_archive (original_id, name, path, size, hash, extension, deleted_by) VALUES ${placeholders}`,
        flat
      );
      archived += batch.length;
    }
    return archived;
  }

  /**
   * Get archived deleted files
   */
  async getDeletedFilesArchive(limit = 200, offset = 0) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }
    const [rows] = await this.connection.query(
      'SELECT * FROM deleted_files_archive ORDER BY deleted_at DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    const [countResult] = await this.connection.query('SELECT COUNT(*) as total FROM deleted_files_archive');
    return { files: rows, total: countResult[0].total };
  }

  /**
   * Record drive usage snapshot
   */
  async recordDriveUsage(drive, totalBytes, usedBytes, freeBytes) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }
    await this.connection.query(
      'INSERT INTO drive_usage_history (drive, total_bytes, used_bytes, free_bytes) VALUES (?, ?, ?, ?)',
      [drive, totalBytes, usedBytes, freeBytes]
    );
  }

  /**
   * Get drive usage history
   */
  async getDriveUsageHistory(drive = null, days = 30) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }
    let query = 'SELECT drive, total_bytes, used_bytes, free_bytes, recorded_at FROM drive_usage_history WHERE recorded_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
    const params = [days];
    if (drive) {
      query += ' AND drive = ?';
      params.push(drive);
    }
    query += ' ORDER BY recorded_at DESC';
    const [rows] = await this.connection.query(query, params);
    return rows;
  }

  /**
   * Get latest drive usage for all drives
   */
  async getLatestDriveUsage() {
    if (!this.connection) {
      throw new Error('Database not connected');
    }
    const [rows] = await this.connection.query(`
      SELECT d.drive, d.total_bytes, d.used_bytes, d.free_bytes, d.recorded_at
      FROM drive_usage_history d
      INNER JOIN (
        SELECT drive, MAX(recorded_at) as max_time
        FROM drive_usage_history
        GROUP BY drive
      ) latest ON d.drive = latest.drive AND d.recorded_at = latest.max_time
      ORDER BY d.drive
    `);
    return rows;
  }

  /**
   * Get smart hashing statistics
   */
  async getSmartHashStats(minSize = 0, maxSize = 0) {
    if (!this.connection) {
      throw new Error('Database not connected');
    }

    const validMinSize = (typeof minSize === 'number' && !isNaN(minSize)) ? minSize : 0;
    const validMaxSize = (maxSize && typeof maxSize === 'number' && maxSize > 0) ? maxSize : 0;

    let sizeFilter = `hash IS NULL AND size >= ${validMinSize}`;
    if (validMaxSize > 0) {
      sizeFilter += ` AND size <= ${validMaxSize}`;
    }

    const [totalResult] = await this.connection.query(
      `SELECT COUNT(*) as count FROM scanned_files WHERE ${sizeFilter}`
    );
    const totalFiles = totalResult[0].count;

    const [dupResult] = await this.connection.query(
      `SELECT COUNT(*) as count FROM scanned_files
       WHERE hash IS NULL AND size >= ${validMinSize}
       ${validMaxSize > 0 ? `AND size <= ${validMaxSize}` : ''}
       AND size IN (
         SELECT size FROM scanned_files
         WHERE ${sizeFilter}
         GROUP BY size HAVING COUNT(*) > 1
       )`
    );
    const filesWithPotentialDuplicates = dupResult[0].count;

    const filesSkipped = totalFiles - filesWithPotentialDuplicates;
    const percentageSkipped = totalFiles > 0
      ? ((filesSkipped / totalFiles) * 100).toFixed(1)
      : 0;

    return { totalFiles, filesWithPotentialDuplicates, filesSkipped, percentageSkipped };
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
      'SELECT sf.id, CONCAT(ft.folder_id, \'\\\\\', sf.name) as path, sf.name, sf.size, sf.hash, sf.quick_hash FROM scanned_files sf LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id WHERE sf.size = ?',
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
        'SELECT sf.id, CONCAT(ft.folder_id, \'\\\\\', sf.name) as path, sf.name, sf.size, sf.mtime FROM scanned_files sf LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id WHERE sf.hash = ? AND sf.size = ?',
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
        CONCAT(ft.folder_id, '\\\\', sf.name) as path,
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
      LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
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
   * Delete a photo and its file from disk
   */
  async deletePhoto(fileId) {
    if (!this.connection) throw new Error('Database not connected');
    // Get file path first
    const [rows] = await this.connection.query(
      `SELECT sf.name, ft.folder_id FROM scanned_files sf
       LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
       WHERE sf.id = ?`, [fileId]
    );
    if (rows.length === 0) return { deleted: 0, path: null };
    const filePath = rows[0].folder_id + '\\' + rows[0].name;
    // Delete from DB (CASCADE will remove photo_metadata)
    const [result] = await this.connection.query('DELETE FROM scanned_files WHERE id = ?', [fileId]);
    return { deleted: result.affectedRows, path: filePath };
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
        CONCAT(ft.folder_id, '\\\\', sf.name) as path,
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
      LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
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
        CONCAT(ft.folder_id, '\\\\', sf.name) as path,
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
      LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
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
      SELECT mph.file_id, mph.played_at, sf.name, CONCAT(ft.folder_id, '\\\\', sf.name) as path
      FROM music_play_history mph
      JOIN scanned_files sf ON mph.file_id = sf.id
      LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
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

  async getThumbnail(fileHash, fileSize, mediaType) {
    if (!this.connection || !fileHash) return null;
    try {
      const [rows] = await this.connection.execute(
        'SELECT thumb_data, content_type FROM thumbnail_cache WHERE file_hash = ? AND file_size = ? AND media_type = ?',
        [fileHash, fileSize, mediaType]
      );
      return rows.length > 0 ? rows[0] : null;
    } catch (err) {
      return null;
    }
  }

  async saveThumbnail(fileHash, fileSize, mediaType, thumbData, contentType = 'image/jpeg') {
    if (!this.connection || !fileHash) return;
    try {
      await this.connection.execute(
        `INSERT INTO thumbnail_cache (file_hash, file_size, media_type, thumb_data, content_type)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE thumb_data = VALUES(thumb_data), content_type = VALUES(content_type), created_at = CURRENT_TIMESTAMP`,
        [fileHash, fileSize, mediaType, thumbData, contentType]
      );
    } catch (err) {
      console.warn('Failed to save thumbnail:', err.message);
    }
  }

  async computeQuickHash(fileId) {
    if (!this.connection) return null;
    try {
      const [rows] = await this.connection.execute(
        'SELECT sf.name, sf.size, sf.quick_hash, ft.folder_id as folder_path FROM scanned_files sf LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id WHERE sf.id = ?',
        [fileId]
      );
      if (rows.length === 0 || !rows[0].folder_path) return null;
      const row = rows[0];
      const filePath = row.folder_path + '\\' + row.name;
      if (row.quick_hash) return { hash: row.quick_hash, size: row.size };
      if (row.hash) return { hash: row.hash, size: row.size };
      return { hash: null, size: row.size, path: filePath };
    } catch (err) {
      return null;
    }
  }

  /**
   * Refresh file_count, total_size for one folder and its ancestors
   */
  async refreshFolderStats(folderId) {
    if (!this.connection) return;

    // Update direct stats for this folder
    await this.connection.query(`
      UPDATE folder_tree SET
        file_count = (SELECT COUNT(*) FROM scanned_files WHERE folder_id_int = ?),
        total_size = (SELECT COALESCE(SUM(size), 0) FROM scanned_files WHERE folder_id_int = ?)
      WHERE id = ?
    `, [folderId, folderId, folderId]);

    // Recalculate all descendants' direct stats
    const [descendants] = await this.connection.query(
      'SELECT id FROM folder_tree WHERE parent_id = ?', [folderId]
    );
    const queue = descendants.map(d => d.id);
    while (queue.length > 0) {
      const current = queue.shift();
      await this.connection.query(`
        UPDATE folder_tree SET
          file_count = (SELECT COUNT(*) FROM scanned_files WHERE folder_id_int = ?),
          total_size = (SELECT COALESCE(SUM(size), 0) FROM scanned_files WHERE folder_id_int = ?)
        WHERE id = ?
      `, [current, current, current]);
      const [sub] = await this.connection.query('SELECT id FROM folder_tree WHERE parent_id = ?', [current]);
      for (const s of sub) queue.push(s.id);
    }

    // Now recalculate recursive stats bottom-up for this folder and all ancestors
    // First, set all descendants to have recursive = direct
    await this.connection.query(`
      UPDATE folder_tree SET recursive_count = file_count, recursive_size = total_size
      WHERE id = ? OR id IN (
        WITH RECURSIVE d AS (
          SELECT id FROM folder_tree WHERE parent_id = ?
          UNION ALL SELECT ft.id FROM folder_tree ft INNER JOIN d ON ft.parent_id = d.id
        ) SELECT id FROM d
      )
    `, [folderId, folderId]);

    // Then walk up from the deepest levels
    let levelsUp = 50;
    while (levelsUp-- > 0) {
      const [updated] = await this.connection.query(`
        UPDATE folder_tree ft
        INNER JOIN (
          SELECT parent_id,
                 COALESCE(SUM(recursive_count), 0) as child_rc,
                 COALESCE(SUM(recursive_size), 0) as child_rs
          FROM folder_tree WHERE parent_id IS NOT NULL
          GROUP BY parent_id
        ) child ON ft.id = child.parent_id
        SET ft.recursive_count = ft.file_count + child.child_rc,
            ft.recursive_size = ft.total_size + child.child_rs
        WHERE ft.id >= ?
      `, [folderId]);
      if (updated.affectedRows === 0) break;
    }
  }

  async rebuildFolderTree() {
    if (!this.connection) return;
    try {
      await this.connection.query('SET FOREIGN_KEY_CHECKS = 0');

      // Step 1: Compute new folder stats from scanned_files via folder_tree
      const [rows] = await this.connection.query(`
        SELECT ft.folder_id, COUNT(*) as file_count, COALESCE(SUM(sf.size), 0) as total_size
        FROM scanned_files sf
        JOIN folder_tree ft ON ft.id = sf.folder_id_int
        GROUP BY ft.folder_id
      `);

      if (rows.length === 0) {
        await this.connection.query('SET FOREIGN_KEY_CHECKS = 1');
        return;
      }

      // Build a map of new folder data
      const newFolders = new Map();
      for (const row of rows) {
        newFolders.set(row.folder_id, {
          file_count: parseInt(row.file_count),
          total_size: parseInt(row.total_size)
        });
      }

      // Get existing folder_tree entries
      const [existing] = await this.connection.query('SELECT id, folder_id FROM folder_tree');
      const existingMap = new Map();
      for (const row of existing) {
        existingMap.set(row.folder_id, row.id);
      }

      // Step 2: Update existing entries' file_count and total_size
      const BATCH = 1000;
      const existingIds = [];
      for (const [folderId, data] of newFolders) {
        if (existingMap.has(folderId)) {
          existingIds.push(folderId);
        }
      }

      for (let i = 0; i < existingIds.length; i += BATCH) {
        const batch = existingIds.slice(i, i + BATCH);
        const values = batch.map(fid => {
          const d = newFolders.get(fid);
          return [d.file_count, d.total_size, fid];
        });
        const ph = values.map(() => '(?, ?, ?)').join(',');
        await this.connection.query(
          `UPDATE folder_tree SET file_count = ?, total_size = ? WHERE folder_id = ?`,
          values.flat()
        );
      }

      // Step 3: Insert new folders that don't exist yet
      const newEntries = [];
      for (const [folderId, data] of newFolders) {
        if (!existingMap.has(folderId)) {
          const segments = folderId.split('\\').filter(Boolean);
          const depth = segments.length;
          newEntries.push([folderId, segments[segments.length - 1] || folderId, data.file_count, data.total_size, depth]);
        }
      }

      if (newEntries.length > 0) {
        for (let i = 0; i < newEntries.length; i += BATCH) {
          const batch = newEntries.slice(i, i + BATCH);
          const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(',');
          const flat = batch.flat();
          await this.connection.execute(
            `INSERT IGNORE INTO folder_tree (folder_id, folder_name, file_count, total_size, depth) VALUES ${placeholders}`,
            flat
          );
        }
      }

      // Step 4: Delete folders that no longer exist in scanned_files
      const toDelete = [];
      for (const [folderId] of existingMap) {
        if (!newFolders.has(folderId)) {
          toDelete.push(folderId);
        }
      }
      // Also clean up stale entries with trailing backslash at depth 1
      const staleDrive = [];
      for (const [folderId] of existingMap) {
        if (folderId.endsWith('\\') && !newFolders.has(folderId)) {
          staleDrive.push(folderId);
        }
      }
      const allDelete = [...new Set([...toDelete, ...staleDrive])];
      if (allDelete.length > 0) {
        for (let i = 0; i < allDelete.length; i += BATCH) {
          const batch = allDelete.slice(i, i + BATCH);
          const ph = batch.map(() => '?').join(',');
          // Redirect children to NULL before deleting
          await this.connection.query(`UPDATE folder_tree SET parent_id = NULL WHERE parent_id IN (SELECT id FROM (SELECT id FROM folder_tree WHERE folder_id IN (${ph})) t)`, batch);
          await this.connection.query(`DELETE FROM folder_tree WHERE folder_id IN (${ph})`, batch);
        }
      }

      // Step 5: Create missing intermediate folders
      const [allCurrent] = await this.connection.query('SELECT folder_id FROM folder_tree');
      const currentSet = new Set(allCurrent.map(r => r.folder_id));
      const allFolderIds = [...newFolders.keys()];
      const missing = [];
      for (const folderId of allFolderIds) {
        const segments = folderId.split('\\').filter(Boolean);
        for (let i = 1; i < segments.length; i++) {
          const parentId = segments.slice(0, i).join('\\');
          if (!currentSet.has(parentId)) {
            currentSet.add(parentId);
            missing.push([parentId, segments[i - 1], 0, 0, i]);
          }
        }
      }
      if (missing.length > 0) {
        for (let i = 0; i < missing.length; i += BATCH) {
          const batch = missing.slice(i, i + BATCH);
          const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(',');
          const flat = batch.flat();
          await this.connection.execute(
            `INSERT IGNORE INTO folder_tree (folder_id, folder_name, file_count, total_size, depth) VALUES ${placeholders}`,
            flat
          );
        }
      }

      // Step 6: Populate parent_id
      await this.connection.query(`
        UPDATE folder_tree child
        INNER JOIN folder_tree parent ON SUBSTRING_INDEX(child.folder_id, '\\\\', child.depth - 1) = parent.folder_id
        SET child.parent_id = parent.id
        WHERE child.depth > 1 AND child.parent_id IS NULL
      `);

      // Step 7: Reset recursive counts to direct counts, then recalculate
      await this.connection.query('UPDATE folder_tree SET recursive_count = file_count, recursive_size = total_size');

      const [maxDepth] = await this.connection.query('SELECT MAX(depth) as maxd FROM folder_tree');
      const maxD = maxDepth[0].maxd || 0;

      for (let d = maxD; d >= 2; d--) {
        await this.connection.query(`
          UPDATE folder_tree p
          JOIN (
            SELECT 
              SUBSTRING_INDEX(folder_id, '\\\\', depth - 1) as parent_fid,
              SUM(recursive_count) as child_count,
              SUM(recursive_size) as child_size
            FROM folder_tree
            WHERE depth = ?
            GROUP BY parent_fid
          ) c ON p.folder_id = c.parent_fid
          SET p.recursive_count = p.recursive_count + c.child_count,
              p.recursive_size = p.recursive_size + c.child_size
        `, [d]);
      }

      await this.connection.query('SET FOREIGN_KEY_CHECKS = 1');
      console.log(`folder_tree rebuilt: ${rows.length} folders (${newEntries.length} new, ${allDelete.length} removed)`);
    } catch (err) {
      await this.connection.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
      console.error('Failed to rebuild folder_tree:', err.message);
    }
  }

  async deduplicateFolderTree() {
    if (!this.connection) return;
    try {
      const [dups] = await this.connection.query("SELECT folder_id FROM folder_tree GROUP BY folder_id HAVING COUNT(*) > 1");
      if (dups.length === 0) return;
      for (const d of dups) {
        const [rows] = await this.connection.query("SELECT id, recursive_count FROM folder_tree WHERE folder_id = ? ORDER BY recursive_count DESC", [d.folder_id]);
        if (rows.length <= 1) continue;
        const keepId = rows[0].id;
        const deleteIds = rows.slice(1).map(r => r.id);
        const ph = deleteIds.map(() => '?').join(',');
        await this.connection.query(`UPDATE folder_tree SET parent_id = ? WHERE parent_id IN (${ph})`, [keepId, ...deleteIds]);
        await this.connection.query(`DELETE FROM folder_tree WHERE id IN (${ph})`, deleteIds);
      }
      console.log(`Deduplicated ${dups.length} folder_tree entries`);
    } catch (err) {
      console.error('Failed to deduplicate folder_tree:', err.message);
    }
  }
}
