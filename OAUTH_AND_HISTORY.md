# Google OAuth and History Tracking Features

This document describes the Google OAuth authentication and history tracking features added to SilverFileSystem.

## Table of Contents
- [Google OAuth Authentication](#google-oauth-authentication)
- [Login History Tracking](#login-history-tracking)
- [Play History Tracking](#play-history-tracking)
- [Enhanced Music Player](#enhanced-music-player)
- [API Reference](#api-reference)
- [Database Schema](#database-schema)

---

## Google OAuth Authentication

### Overview
Users can now sign in using their Google account in addition to traditional username/password authentication.

### Features
- **"Sign in with Google" button** on login page
- **Automatic user creation** from Google profile
- **Profile data import**: Email, display name, profile picture, Google ID
- **Seamless JWT generation** for OAuth users
- **Session management** with secure cookies

### Setup Instructions

#### 1. Create Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth 2.0 Client ID**
5. Configure the OAuth consent screen if prompted
6. Select **Web application** as application type
7. Add authorized redirect URI:
   - Development: `http://localhost:4000/api/auth/google/callback`
   - Production: `https://yourdomain.com/api/auth/google/callback`
8. Copy the **Client ID** and **Client Secret**

#### 2. Configure Environment Variables

Add to your `.env` file:

```bash
# Google OAuth Configuration
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=http://localhost:4000/api/auth/google/callback

# Session Secret (required for OAuth)
SESSION_SECRET=your-secure-random-session-secret

# Production settings
NODE_ENV=production
FRONTEND_URL=https://yourdomain.com
```

Generate secure secrets:
```bash
# Generate session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

#### 3. Start the Server

```bash
npm install
npm run server
```

If Google OAuth is configured, you'll see:
```
✓ Google OAuth configured
```

If not configured, the server still works with local authentication:
```
ℹ️  Google OAuth not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable)
```

### User Flow

1. **New User (OAuth)**:
   - Clicks "Sign in with Google"
   - Redirected to Google login
   - Authorizes application
   - Redirected back with JWT token
   - User record created automatically

2. **Existing User (OAuth)**:
   - Clicks "Sign in with Google"
   - Redirected to Google
   - Profile picture updated if changed
   - Redirected back with JWT token

3. **Username Collision**:
   - If Google display name already exists as username
   - System appends random suffix to make it unique
   - Example: `john_doe` becomes `john_doe_a3f2b8e1`

---

## Login History Tracking

### Overview
Every user login (local or OAuth) is automatically recorded in the database.

### Recorded Information
- **User ID**: Who logged in
- **IP Address**: Client IP address
- **User Agent**: Browser and device information
- **Auth Method**: `local` or `google`
- **Timestamp**: When the login occurred

### Database Table

```sql
CREATE TABLE login_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  ip_address VARCHAR(45),
  user_agent VARCHAR(512),
  auth_method ENUM('local', 'google') DEFAULT 'local',
  login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_login_time (login_time),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### API Endpoint

**Get Login History**

```http
GET /api/history/login?limit=50
Authorization: Bearer <token>
```

**Response:**
```json
{
  "history": [
    {
      "id": 1,
      "ip_address": "192.168.1.100",
      "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...",
      "auth_method": "google",
      "login_time": "2025-11-04T04:30:56.000Z"
    },
    {
      "id": 2,
      "ip_address": "192.168.1.100",
      "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X)...",
      "auth_method": "local",
      "login_time": "2025-11-03T10:15:23.000Z"
    }
  ]
}
```

### Use Cases
- **Security monitoring**: Detect unusual login patterns
- **Suspicious activity**: Multiple failed attempts or logins from new IPs
- **User analytics**: Track when users are most active
- **Compliance**: Maintain audit trail for access

---

## Play History Tracking

### Overview
Every time a user plays media (audio/video), the event is recorded with context about how it was triggered.

### Recorded Information
- **User ID**: Who played the media
- **File ID**: Which file was played
- **IP Address**: Client IP address
- **Play Type**: How playback was triggered
  - `click`: User directly clicked on track
  - `queue`: Playing from queue
  - `auto_next`: Automatic next track
  - `random`: Random/shuffle playback
- **Timestamp**: When playback started

### Database Table

```sql
CREATE TABLE play_history (
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
);
```

### API Endpoints

**Record Play History**

```http
POST /api/history/play
Authorization: Bearer <token>
Content-Type: application/json

{
  "fileId": 123,
  "playType": "click"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Play history recorded"
}
```

**Get Play History**

```http
GET /api/history/play?limit=100
Authorization: Bearer <token>
```

**Response:**
```json
{
  "history": [
    {
      "id": 1,
      "file_id": 123,
      "ip_address": "192.168.1.100",
      "play_type": "click",
      "played_at": "2025-11-04T04:35:20.000Z",
      "name": "Song Name.mp3",
      "path": "/music/artist/album/song.mp3",
      "size": 8456723
    },
    {
      "id": 2,
      "file_id": 124,
      "play_type": "auto_next",
      "played_at": "2025-11-04T04:38:45.000Z",
      "name": "Next Song.mp3",
      "path": "/music/artist/album/next.mp3",
      "size": 7234567
    }
  ]
}
```

### Automatic Recording

Play history is automatically recorded when:
- User streams audio via `/audio/:id`
- User streams video via `/video/:id`
- Play type is determined by the music player context

### Use Cases
- **Recently played**: Show user's recent listening history
- **Most played**: Track most popular songs per user
- **Recommendations**: Build personalized recommendations
- **Analytics**: Understand listening patterns
- **Resume playback**: Remember where user left off

---

## Enhanced Music Player

### Auto-Play Next Song

The music player now automatically plays the next track when:
1. Current song finishes
2. Queue is empty (plays next in current list)
3. Queue has tracks (plays next in queue)

**Behavior:**
```javascript
// Priority order:
1. If queue has next track -> play from queue (type: 'queue')
2. If no queue but current list has next -> play next track (type: 'auto_next')
3. If end of list -> stop
```

### Play Type Tracking

Every playback is marked with how it was triggered:

- **`click`**: User clicked on a track
- **`queue`**: Playing from the play queue
- **`auto_next`**: Automatically played next track
- **`random`**: Random/shuffle mode (future feature)

### Implementation

```javascript
// In music.html

// Direct click
function playTrackByIndex(index) {
    playTrack(allTracks[index], 'click');
}

// From queue
function playFromQueue(index) {
    playTrack(playQueue[index], 'queue');
}

// Auto-next
audioElement.addEventListener('ended', function() {
    playNext(); // Automatically determines type
});
```

---

## API Reference

### Authentication Endpoints

#### Initiate Google OAuth
```http
GET /api/auth/google
```
Redirects to Google login page.

#### OAuth Callback
```http
GET /api/auth/google/callback
```
Handles Google OAuth callback. Redirects to login page with token.

#### Local Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "password123"
}
```

#### Register
```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "newuser",
  "password": "securepass123"
}
```

### History Endpoints

All history endpoints require authentication via `Authorization: Bearer <token>` header.

#### Record Play History
```http
POST /api/history/play
Content-Type: application/json

{
  "fileId": 123,
  "playType": "click"  // optional, defaults to 'click'
}
```

#### Get Play History
```http
GET /api/history/play?limit=100
```

#### Get Login History
```http
GET /api/history/login?limit=50
```

---

## Database Schema

### Users Table (Updated)

```sql
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255),              -- NULL for OAuth-only users
  email VARCHAR(255),                      -- From OAuth
  google_id VARCHAR(255),                  -- Google OAuth ID
  profile_picture VARCHAR(512),            -- Profile picture URL
  auth_provider ENUM('local', 'google') DEFAULT 'local',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_username (username),
  INDEX idx_google_id (google_id),
  INDEX idx_email (email)
);
```

### Login History Table (New)

```sql
CREATE TABLE login_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  ip_address VARCHAR(45),                  -- Supports IPv4 and IPv6
  user_agent VARCHAR(512),                 -- Browser information
  auth_method ENUM('local', 'google') DEFAULT 'local',
  login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_login_time (login_time),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### Play History Table (New)

```sql
CREATE TABLE play_history (
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
);
```

---

## Privacy Considerations

### Data Collection
- **IP addresses**: Stored for security purposes (detecting suspicious logins)
- **User agents**: Stored to identify devices/browsers
- **Play history**: Used for personalization features

### Data Retention
- No automatic deletion currently implemented
- Consider implementing retention policies:
  - Delete login history older than 90 days
  - Delete play history older than 1 year
  - Or keep all history for analytics

### User Rights
- Users should be able to:
  - View their own history
  - Delete their own history (future feature)
  - Export their data (future feature)

### Security
- History data only accessible via authenticated API
- Each user can only access their own history
- Admin tools for history management (future feature)

---

## Future Enhancements

### Analytics Dashboard
- Total listening time per user
- Most played tracks/artists/albums
- Listening habits (time of day, day of week)
- Genre preferences

### Social Features
- Share recently played
- See what friends are listening to
- Public profiles (opt-in)

### Smart Features
- Resume playback where left off
- Personalized recommendations based on history
- Similar tracks suggestion
- Discover weekly (like Spotify)

### Advanced Playback
- Shuffle/random mode with history tracking
- Smart playlists based on history
- "Don't play this again" option
- Play count tracking

---

## Troubleshooting

### Google OAuth Not Working

**Check configuration:**
```bash
# Verify environment variables are set
echo $GOOGLE_CLIENT_ID
echo $GOOGLE_CLIENT_SECRET
```

**Check redirect URI:**
- Must match exactly in Google Console
- Include protocol (http/https)
- Include port if not standard (80/443)
- No trailing slash

**Check server logs:**
```
✓ Google OAuth configured  # Should see this on startup
```

### Login History Not Recording

**Check database:**
```sql
SELECT * FROM login_history ORDER BY login_time DESC LIMIT 5;
```

**Check server logs:**
```
Error recording login history: [error message]
```

**Note:** Login recording failures don't prevent login from succeeding.

### Play History Not Recording

**Check API call:**
```javascript
// In browser console
const token = localStorage.getItem('silverfs_token');
fetch('/api/history/play', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({ fileId: 123, playType: 'click' })
}).then(r => r.json()).then(console.log);
```

**Check database:**
```sql
SELECT * FROM play_history ORDER BY played_at DESC LIMIT 5;
```

---

## Security Best Practices

### Production Deployment

1. **Use HTTPS**: Required for OAuth in production
2. **Secure cookies**: Set in production mode
3. **Strong secrets**: Use cryptographically secure random values
4. **Limit data retention**: Delete old history records
5. **Rate limiting**: Prevent history spam (already implemented)
6. **Input validation**: Sanitize user inputs (already implemented)

### Environment Variables

```bash
# Required
JWT_SECRET=<64-char-hex-string>
SESSION_SECRET=<32-char-hex-string>

# Google OAuth (optional)
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>
GOOGLE_CALLBACK_URL=https://yourdomain.com/api/auth/google/callback

# Production settings
NODE_ENV=production
FRONTEND_URL=https://yourdomain.com
```

---

## Conclusion

These features enhance SilverFileSystem with modern authentication options and comprehensive usage tracking while maintaining user privacy and security. The system is designed to be extensible for future features like personalized recommendations and social sharing.
