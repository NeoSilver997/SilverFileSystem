import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

// JWT secret - MUST be set in production via environment variable
// If not set, generate a random secret (will be different on each restart)
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const randomSecret = crypto.randomBytes(64).toString('hex');
  console.warn('⚠️  WARNING: JWT_SECRET not set in environment variables!');
  console.warn('⚠️  Using randomly generated secret. Set JWT_SECRET in production!');
  console.warn('⚠️  Users will need to re-login after server restart.');
  return randomSecret;
})();
const JWT_EXPIRY = '24h'; // Token expires in 24 hours

/**
 * Authentication Manager for user login and JWT token handling
 */
export class AuthManager {
  constructor(db) {
    this.db = db;
  }

  /**
   * Initialize users table in the database
   */
  async initializeUsersTable() {
    try {
      // Create users table
      await this.db.connection.execute(`
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
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_username (username),
          INDEX idx_google_id (google_id),
          INDEX idx_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('✓ Users table initialized');

      // Create login_history table
      await this.db.connection.execute(`
        CREATE TABLE IF NOT EXISTS login_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          ip_address VARCHAR(45),
          user_agent VARCHAR(512),
          auth_method ENUM('local', 'google') DEFAULT 'local',
          login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_user_id (user_id),
          INDEX idx_login_time (login_time),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('✓ Login history table initialized');

      // Create play_history table
      await this.db.connection.execute(`
        CREATE TABLE IF NOT EXISTS play_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          file_id INT NOT NULL,
          ip_address VARCHAR(45),
          play_type ENUM('click', 'queue', 'auto_next', 'random') DEFAULT 'click',
          played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_user_id (user_id),
          INDEX idx_file_id (file_id),
          INDEX idx_played_at (played_at),
          INDEX idx_play_type (play_type),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('✓ Play history table initialized');
    } catch (err) {
      console.error('Failed to initialize tables:', err.message);
      throw err;
    }
  }

  /**
   * Create a default admin user if no users exist
   */
  async createDefaultUser() {
    try {
      const [rows] = await this.db.connection.query('SELECT COUNT(*) as count FROM users');
      
      if (rows[0].count === 0) {
        // Check if admin credentials are provided via environment variables
        const defaultUsername = process.env.ADMIN_USERNAME || 'admin';
        let defaultPassword;
        
        if (process.env.ADMIN_PASSWORD) {
          defaultPassword = process.env.ADMIN_PASSWORD;
        } else {
          // Generate a random password if not provided
          defaultPassword = crypto.randomBytes(16).toString('hex');
          
          // Only log credentials in development/first setup
          // In production, credentials should be set via environment variables
          if (process.env.NODE_ENV !== 'production') {
            console.log('═'.repeat(70));
            console.log('⚠️  IMPORTANT: No ADMIN_PASSWORD environment variable set!');
            console.log('⚠️  Generated random password for admin user:');
            console.log('');
            console.log(`   Username: ${defaultUsername}`);
            console.log(`   Password: ${defaultPassword}`);
            console.log('');
            console.log('⚠️  Please save this password! It will not be shown again.');
            console.log('⚠️  Set ADMIN_PASSWORD environment variable for production use.');
            console.log('═'.repeat(70));
          } else {
            console.error('❌ PRODUCTION ERROR: ADMIN_PASSWORD must be set in environment!');
            throw new Error('ADMIN_PASSWORD environment variable is required in production');
          }
        }
        
        const passwordHash = await bcrypt.hash(defaultPassword, 10);
        
        await this.db.connection.execute(
          'INSERT INTO users (username, password_hash, is_enabled, is_admin) VALUES (?, ?, TRUE, TRUE)',
          [defaultUsername, passwordHash]
        );
        
        // Only show this message if using environment variable password
        if (process.env.ADMIN_PASSWORD) {
          console.log(`✓ Default user created (username: ${defaultUsername})`);
        }
      }
    } catch (err) {
      console.error('Failed to create default user:', err.message);
      throw err;
    }
  }

  /**
   * Register a new user
   */
  async register(username, password) {
    try {
      // Validate input
      if (!username || username.length < 3) {
        throw new Error('Username must be at least 3 characters long');
      }
      if (!password || password.length < 6) {
        throw new Error('Password must be at least 6 characters long');
      }

      // Check if user already exists
      const [existing] = await this.db.connection.query(
        'SELECT id FROM users WHERE username = ?',
        [username]
      );

      if (existing.length > 0) {
        throw new Error('Username already exists');
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Insert new user (disabled by default, requires admin approval)
      await this.db.connection.execute(
        'INSERT INTO users (username, password_hash, is_enabled) VALUES (?, ?, FALSE)',
        [username, passwordHash]
      );

      return { success: true, message: 'User registered successfully. Please wait for admin approval before logging in.' };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Login user and generate JWT token
   */
  async login(username, password) {
    try {
      // Validate input
      if (!username || !password) {
        throw new Error('Username and password are required');
      }

      // Get user from database
      const [users] = await this.db.connection.query(
        'SELECT id, username, password_hash, is_enabled FROM users WHERE username = ?',
        [username]
      );

      if (users.length === 0) {
        throw new Error('Invalid username or password');
      }

      const user = users[0];

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password_hash);

      if (!isValidPassword) {
        throw new Error('Invalid username or password');
      }

      // Check if user is enabled
      if (!user.is_enabled) {
        throw new Error('Your account is pending admin approval. Please contact an administrator.');
      }

      // Generate JWT token
      const token = jwt.sign(
        { 
          id: user.id, 
          username: user.username 
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
      );

      return {
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username
        }
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Verify JWT token
   */
  verifyToken(token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      return { valid: true, decoded };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  /**
   * Find or create a user from Google OAuth profile
   */
  async findOrCreateGoogleUser(profile) {
    try {
      // Check if user already exists with this Google ID
      const [existingUsers] = await this.db.connection.query(
        'SELECT id, username, email, profile_picture, is_enabled FROM users WHERE google_id = ?',
        [profile.id]
      );

      if (existingUsers.length > 0) {
        // User exists, check if enabled
        const user = existingUsers[0];
        
        if (!user.is_enabled) {
          throw new Error('Your account is pending admin approval. Please contact an administrator.');
        }
        
        const newProfilePic = profile.photos && profile.photos.length > 0 ? profile.photos[0].value : null;
        
        if (newProfilePic && newProfilePic !== user.profile_picture) {
          await this.db.connection.execute(
            'UPDATE users SET profile_picture = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [newProfilePic, user.id]
          );
        }

        return {
          id: user.id,
          username: user.username,
          email: user.email,
          profile_picture: newProfilePic || user.profile_picture
        };
      }

      // User doesn't exist, create new user
      const email = profile.emails && profile.emails.length > 0 ? profile.emails[0].value : null;
      const username = profile.displayName || email?.split('@')[0] || `google_${profile.id}`;
      const profilePicture = profile.photos && profile.photos.length > 0 ? profile.photos[0].value : null;

      // Check if username already exists, if so, append random suffix
      const [usernameCheck] = await this.db.connection.query(
        'SELECT id FROM users WHERE username = ?',
        [username]
      );

      let finalUsername = username;
      if (usernameCheck.length > 0) {
        finalUsername = `${username}_${crypto.randomBytes(4).toString('hex')}`;
      }

      // Insert new user (disabled by default, requires admin approval)
      const [result] = await this.db.connection.execute(
        `INSERT INTO users (username, email, google_id, profile_picture, auth_provider, is_enabled) 
         VALUES (?, ?, ?, ?, 'google', FALSE)`,
        [finalUsername, email, profile.id, profilePicture]
      );

      return {
        id: result.insertId,
        username: finalUsername,
        email: email,
        profile_picture: profilePicture
      };
    } catch (err) {
      console.error('Error in findOrCreateGoogleUser:', err);
      throw err;
    }
  }

  /**
   * Generate JWT token for Google OAuth user
   */
  generateTokenForUser(user) {
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        email: user.email
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    return {
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        profile_picture: user.profile_picture
      }
    };
  }

  /**
   * Record user login history
   */
  async recordLoginHistory(userId, ipAddress, authMethod = 'local', userAgent = null) {
    try {
      await this.db.connection.execute(
        `INSERT INTO login_history (user_id, ip_address, user_agent, auth_method) 
         VALUES (?, ?, ?, ?)`,
        [userId, ipAddress, userAgent, authMethod]
      );
    } catch (err) {
      console.error('Error recording login history:', err);
      // Don't throw - login should succeed even if history recording fails
    }
  }

  /**
   * Record media play history
   */
  async recordPlayHistory(userId, fileId, ipAddress, playType = 'click') {
    try {
      await this.db.connection.execute(
        `INSERT INTO play_history (user_id, file_id, ip_address, play_type) 
         VALUES (?, ?, ?, ?)`,
        [userId, fileId, ipAddress, playType]
      );
    } catch (err) {
      console.error('Error recording play history:', err);
      // Don't throw - playback should succeed even if history recording fails
    }
  }

  /**
   * Get user login history
   */
  async getLoginHistory(userId, limit = 50) {
    try {
      const [rows] = await this.db.connection.query(
        `SELECT id, ip_address, user_agent, auth_method, login_time 
         FROM login_history 
         WHERE user_id = ? 
         ORDER BY login_time DESC 
         LIMIT ?`,
        [userId, limit]
      );
      return rows;
    } catch (err) {
      console.error('Error fetching login history:', err);
      return [];
    }
  }

  /**
   * Get user play history
   */
  async getPlayHistory(userId, limit = 100) {
    try {
      const [rows] = await this.db.connection.query(
        `SELECT ph.id, ph.file_id, ph.ip_address, ph.play_type, ph.played_at, 
                sf.name, sf.path, sf.size 
         FROM play_history ph
         LEFT JOIN scanned_files sf ON ph.file_id = sf.id
         WHERE ph.user_id = ? 
         ORDER BY ph.played_at DESC 
         LIMIT ?`,
        [userId, limit]
      );
      return rows;
    } catch (err) {
      console.error('Error fetching play history:', err);
      return [];
    }
  }

  /**
   * Get all users (admin only)
   */
  async getAllUsers() {
    try {
      const [rows] = await this.db.connection.query(
        `SELECT id, username, email, auth_provider, is_enabled, is_admin, created_at 
         FROM users 
         ORDER BY created_at DESC`
      );
      return rows;
    } catch (err) {
      console.error('Error fetching users:', err);
      return [];
    }
  }

  /**
   * Get pending users (not yet enabled)
   */
  async getPendingUsers() {
    try {
      const [rows] = await this.db.connection.query(
        `SELECT id, username, email, auth_provider, created_at 
         FROM users 
         WHERE is_enabled = FALSE 
         ORDER BY created_at DESC`
      );
      return rows;
    } catch (err) {
      console.error('Error fetching pending users:', err);
      return [];
    }
  }

  /**
   * Enable a user account
   */
  async enableUser(userId) {
    try {
      const [result] = await this.db.connection.execute(
        'UPDATE users SET is_enabled = TRUE WHERE id = ?',
        [userId]
      );
      
      if (result.affectedRows === 0) {
        throw new Error('User not found');
      }
      
      return { success: true, message: 'User enabled successfully' };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Disable a user account
   */
  async disableUser(userId) {
    try {
      const [result] = await this.db.connection.execute(
        'UPDATE users SET is_enabled = FALSE WHERE id = ?',
        [userId]
      );
      
      if (result.affectedRows === 0) {
        throw new Error('User not found');
      }
      
      return { success: true, message: 'User disabled successfully' };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Check if user is admin
   */
  async isAdmin(userId) {
    try {
      const [rows] = await this.db.connection.query(
        'SELECT is_admin FROM users WHERE id = ?',
        [userId]
      );
      
      return rows.length > 0 && rows[0].is_admin === 1;
    } catch (err) {
      console.error('Error checking admin status:', err);
      return false;
    }
  }
}

/**
 * Express middleware to protect routes with JWT authentication
 */
export function authMiddleware(req, res, next) {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Extract token from "Bearer <token>" format
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({ error: 'Invalid token format' });
    }

    const token = parts[1];

    // Verify token
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded; // Attach user info to request
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Authentication error' });
  }
}

/**
 * Express middleware to protect admin-only routes
 * Must be used after authMiddleware
 */
export function adminMiddleware(authManager) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const isAdmin = await authManager.isAdmin(req.user.id);
      
      if (!isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      next();
    } catch (err) {
      return res.status(500).json({ error: 'Authorization error' });
    }
  };
}
