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
      await this.db.connection.execute(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(255) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_username (username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('✓ Users table initialized');
    } catch (err) {
      console.error('Failed to initialize users table:', err.message);
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
        const defaultPassword = process.env.ADMIN_PASSWORD || (() => {
          // Generate a random password if not provided
          const randomPassword = crypto.randomBytes(16).toString('hex');
          console.log('═'.repeat(70));
          console.log('⚠️  IMPORTANT: No ADMIN_PASSWORD environment variable set!');
          console.log('⚠️  Generated random password for admin user:');
          console.log('');
          console.log(`   Username: ${defaultUsername}`);
          console.log(`   Password: ${randomPassword}`);
          console.log('');
          console.log('⚠️  Please save this password! It will not be shown again.');
          console.log('⚠️  Set ADMIN_PASSWORD environment variable to use a custom password.');
          console.log('═'.repeat(70));
          return randomPassword;
        })();
        
        const passwordHash = await bcrypt.hash(defaultPassword, 10);
        
        await this.db.connection.execute(
          'INSERT INTO users (username, password_hash) VALUES (?, ?)',
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

      // Insert new user
      await this.db.connection.execute(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)',
        [username, passwordHash]
      );

      return { success: true, message: 'User registered successfully' };
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
        'SELECT id, username, password_hash FROM users WHERE username = ?',
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
