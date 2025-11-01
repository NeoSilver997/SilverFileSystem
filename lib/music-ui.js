/**
 * Music Player UI Generator
 * Creates an interactive web interface for browsing and playing music
 */
export class MusicPlayerGenerator {
  /**
   * Generate the music player HTML
   * @param {Array} tracks - Array of music data with metadata
   * @param {Object} stats - Statistics about the music collection
   * @returns {string} HTML content
   */
  static generateHTML(tracks, stats) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Music Player - SilverFileSystem</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            color: white;
            min-height: 100vh;
        }

        .header {
            padding: 2rem;
            text-align: center;
        }

        .header h1 {
            font-size: 3rem;
            margin-bottom: 0.5rem;
            font-weight: 700;
        }

        .header p {
            font-size: 1.2rem;
            opacity: 0.9;
        }

        .stats-bar {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 1rem;
            padding: 1rem 2rem;
            background: rgba(0, 0, 0, 0.2);
        }

        .stat-card {
            text-align: center;
            padding: 1rem;
        }

        .stat-number {
            font-size: 1.8rem;
            font-weight: bold;
        }

        .stat-label {
            font-size: 0.9rem;
            opacity: 0.8;
            margin-top: 0.3rem;
        }

        .player-container {
            max-width: 1400px;
            margin: 2rem auto;
            padding: 0 2rem;
        }

        .controls-panel {
            background: rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(10px);
            padding: 1.5rem;
            border-radius: 16px;
            margin-bottom: 2rem;
            display: flex;
            flex-wrap: wrap;
            gap: 1rem;
            align-items: center;
        }

        .search-box {
            flex: 1;
            min-width: 250px;
        }

        .search-box input {
            width: 100%;
            padding: 0.75rem 1rem;
            border: 2px solid rgba(255, 255, 255, 0.2);
            background: rgba(255, 255, 255, 0.1);
            color: white;
            border-radius: 8px;
            font-size: 1rem;
            transition: all 0.3s;
        }

        .search-box input::placeholder {
            color: rgba(255, 255, 255, 0.6);
        }

        .search-box input:focus {
            outline: none;
            border-color: rgba(255, 255, 255, 0.5);
            background: rgba(255, 255, 255, 0.15);
        }

        .filter-group {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
        }

        .filter-btn {
            padding: 0.75rem 1.5rem;
            border: 2px solid rgba(255, 255, 255, 0.2);
            background: rgba(255, 255, 255, 0.1);
            color: white;
            border-radius: 8px;
            cursor: pointer;
            font-size: 0.9rem;
            transition: all 0.3s;
        }

        .filter-btn:hover {
            background: rgba(255, 255, 255, 0.2);
        }

        .filter-btn.active {
            background: rgba(255, 255, 255, 0.3);
            border-color: rgba(255, 255, 255, 0.5);
        }

        .main-content {
            display: grid;
            grid-template-columns: 300px 1fr;
            gap: 2rem;
        }

        .sidebar {
            background: rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(10px);
            border-radius: 16px;
            padding: 1.5rem;
            height: fit-content;
            max-height: 70vh;
            overflow-y: auto;
        }

        .sidebar h2 {
            font-size: 1.3rem;
            margin-bottom: 1rem;
            padding-bottom: 0.5rem;
            border-bottom: 2px solid rgba(255, 255, 255, 0.2);
        }

        .playlist-item {
            padding: 0.75rem;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.3s;
            margin-bottom: 0.5rem;
        }

        .playlist-item:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        .playlist-item.active {
            background: rgba(255, 255, 255, 0.2);
        }

        .playlist-name {
            font-weight: 600;
            margin-bottom: 0.25rem;
        }

        .playlist-count {
            font-size: 0.85rem;
            opacity: 0.7;
        }

        .track-list {
            background: rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(10px);
            border-radius: 16px;
            padding: 1.5rem;
            max-height: 70vh;
            overflow-y: auto;
        }

        .track-header {
            display: grid;
            grid-template-columns: 50px 1fr 200px 100px 80px;
            gap: 1rem;
            padding: 0.75rem 1rem;
            border-bottom: 2px solid rgba(255, 255, 255, 0.2);
            font-weight: 600;
            font-size: 0.9rem;
            opacity: 0.7;
        }

        .track-item {
            display: grid;
            grid-template-columns: 50px 1fr 200px 100px 80px;
            gap: 1rem;
            padding: 1rem;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s;
            align-items: center;
            margin-bottom: 0.5rem;
        }

        .track-item:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        .track-item.playing {
            background: rgba(255, 255, 255, 0.2);
        }

        .track-number {
            text-align: center;
            font-weight: 600;
        }

        .track-info {
            display: flex;
            flex-direction: column;
        }

        .track-title {
            font-weight: 600;
            margin-bottom: 0.25rem;
        }

        .track-artist {
            font-size: 0.85rem;
            opacity: 0.7;
        }

        .track-album {
            font-size: 0.9rem;
        }

        .track-duration {
            text-align: center;
        }

        .track-quality {
            text-align: center;
            font-size: 0.8rem;
        }

        .quality-badge {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 4px;
        }

        .now-playing {
            background: rgba(0, 0, 0, 0.4);
            backdrop-filter: blur(10px);
            border-radius: 16px;
            padding: 2rem;
            margin-top: 2rem;
            display: none;
        }

        .now-playing.active {
            display: block;
        }

        .now-playing-header {
            text-align: center;
            margin-bottom: 2rem;
        }

        .now-playing-title {
            font-size: 2rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
        }

        .now-playing-artist {
            font-size: 1.3rem;
            opacity: 0.8;
        }

        .now-playing-album {
            font-size: 1rem;
            opacity: 0.6;
            margin-top: 0.25rem;
        }

        .player-controls {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 2rem;
            margin: 2rem 0;
        }

        .control-btn {
            background: rgba(255, 255, 255, 0.2);
            border: none;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 1.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s;
        }

        .control-btn:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: scale(1.1);
        }

        .control-btn.play-btn {
            width: 80px;
            height: 80px;
            font-size: 2rem;
            background: rgba(255, 255, 255, 0.3);
        }

        .progress-bar {
            width: 100%;
            height: 8px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 4px;
            cursor: pointer;
            position: relative;
            margin: 1rem 0;
        }

        .progress-fill {
            height: 100%;
            background: white;
            border-radius: 4px;
            width: 0%;
            transition: width 0.1s;
        }

        .time-display {
            display: flex;
            justify-content: space-between;
            font-size: 0.9rem;
            opacity: 0.7;
        }

        .no-results {
            text-align: center;
            padding: 4rem 2rem;
        }

        .no-results h2 {
            font-size: 2rem;
            margin-bottom: 1rem;
        }

        @media (max-width: 1024px) {
            .main-content {
                grid-template-columns: 1fr;
            }

            .sidebar {
                max-height: none;
            }

            .track-header,
            .track-item {
                grid-template-columns: 40px 1fr 80px;
                font-size: 0.9rem;
            }

            .track-album,
            .track-quality {
                display: none;
            }
        }

        @media (max-width: 768px) {
            .controls-panel {
                flex-direction: column;
            }

            .search-box {
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎵 Music Player</h1>
        <p>Your complete music collection</p>
    </div>

    <div class="stats-bar">
        <div class="stat-card">
            <div class="stat-number">${stats.totalTracks || 0}</div>
            <div class="stat-label">Total Tracks</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.totalAlbums || 0}</div>
            <div class="stat-label">Albums</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.totalArtists || 0}</div>
            <div class="stat-label">Artists</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.totalDuration || '0:00'}</div>
            <div class="stat-label">Total Duration</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.totalSize || '0 B'}</div>
            <div class="stat-label">Total Size</div>
        </div>
    </div>

    <div class="player-container">
        <div class="controls-panel">
            <div class="search-box">
                <input type="text" id="searchInput" placeholder="Search tracks, artists, albums...">
            </div>
            <div class="filter-group">
                <button class="filter-btn active" data-filter="all">All</button>
                <button class="filter-btn" data-filter="flac">FLAC</button>
                <button class="filter-btn" data-filter="hq">High Quality</button>
                <button class="filter-btn" data-filter="recent">Recently Added</button>
            </div>
        </div>

        <div class="main-content">
            <div class="sidebar">
                <h2>Playlists</h2>
                <div id="playlistContainer"></div>
            </div>

            <div class="track-list">
                <div class="track-header">
                    <div>#</div>
                    <div>Title</div>
                    <div class="track-album">Album</div>
                    <div class="track-duration">Duration</div>
                    <div class="track-quality">Quality</div>
                </div>
                <div id="trackContainer"></div>
            </div>
        </div>

        <div id="nowPlaying" class="now-playing">
            <div class="now-playing-header">
                <div class="now-playing-title" id="npTitle">-</div>
                <div class="now-playing-artist" id="npArtist">-</div>
                <div class="now-playing-album" id="npAlbum">-</div>
            </div>

            <div class="player-controls">
                <button class="control-btn" onclick="previousTrack()">⏮</button>
                <button class="control-btn play-btn" id="playPauseBtn" onclick="togglePlayPause()">▶</button>
                <button class="control-btn" onclick="nextTrack()">⏭</button>
                <button class="control-btn" onclick="toggleShuffle()">🔀</button>
                <button class="control-btn" onclick="toggleRepeat()">🔁</button>
            </div>

            <div class="progress-bar" id="progressBar" onclick="seekTo(event)">
                <div class="progress-fill" id="progressFill"></div>
            </div>

            <div class="time-display">
                <span id="currentTime">0:00</span>
                <span id="totalTime">0:00</span>
            </div>
        </div>
    </div>

    <script>
        const tracksData = ${JSON.stringify(tracks)};
        let filteredTracks = [...tracksData];
        let currentTrackIndex = -1;
        let isPlaying = false;
        let currentFilter = 'all';

        // Group tracks by album and artist
        const albums = {};
        const artists = {};
        tracksData.forEach(track => {
            if (track.album) {
                if (!albums[track.album]) {
                    albums[track.album] = [];
                }
                albums[track.album].push(track);
            }
            if (track.artist) {
                if (!artists[track.artist]) {
                    artists[track.artist] = [];
                }
                artists[track.artist].push(track);
            }
        });

        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        function formatDuration(seconds) {
            if (!seconds) return '0:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return \`\${mins}:\${secs.toString().padStart(2, '0')}\`;
        }

        function getQualityBadge(track) {
            if (track.codec === 'FLAC') return 'FLAC';
            if (track.bitrate >= 320000) return '320k';
            if (track.bitrate >= 256000) return '256k';
            if (track.bitrate >= 192000) return '192k';
            return \`\${Math.floor(track.bitrate / 1000)}k\`;
        }

        function renderPlaylists() {
            const container = document.getElementById('playlistContainer');
            
            const playlists = [
                { name: 'All Tracks', count: tracksData.length, id: 'all' },
                { name: 'Artists', count: Object.keys(artists).length, id: 'artists' },
                { name: 'Albums', count: Object.keys(albums).length, id: 'albums' }
            ];

            container.innerHTML = playlists.map(playlist => \`
                <div class="playlist-item \${playlist.id === 'all' ? 'active' : ''}" onclick="selectPlaylist('\${playlist.id}')">
                    <div class="playlist-name">\${playlist.name}</div>
                    <div class="playlist-count">\${playlist.count} items</div>
                </div>
            \`).join('');
        }

        function renderTracks() {
            const container = document.getElementById('trackContainer');
            
            if (filteredTracks.length === 0) {
                container.innerHTML = \`
                    <div class="no-results">
                        <h2>No tracks found</h2>
                        <p>Try adjusting your search or filters</p>
                    </div>
                \`;
                return;
            }

            container.innerHTML = filteredTracks.map((track, index) => \`
                <div class="track-item \${index === currentTrackIndex ? 'playing' : ''}" onclick="playTrack(\${index})">
                    <div class="track-number">\${index === currentTrackIndex && isPlaying ? '▶' : (index + 1)}</div>
                    <div class="track-info">
                        <div class="track-title">\${track.title || track.name}</div>
                        <div class="track-artist">\${track.artist || 'Unknown Artist'}</div>
                    </div>
                    <div class="track-album">\${track.album || '-'}</div>
                    <div class="track-duration">\${formatDuration(track.duration)}</div>
                    <div class="track-quality">
                        <span class="quality-badge">\${getQualityBadge(track)}</span>
                    </div>
                </div>
            \`).join('');
        }

        function applyFilters() {
            let results = tracksData;
            const searchTerm = document.getElementById('searchInput').value.toLowerCase();

            // Apply search
            if (searchTerm) {
                results = results.filter(track => 
                    (track.title && track.title.toLowerCase().includes(searchTerm)) ||
                    (track.name && track.name.toLowerCase().includes(searchTerm)) ||
                    (track.artist && track.artist.toLowerCase().includes(searchTerm)) ||
                    (track.album && track.album.toLowerCase().includes(searchTerm))
                );
            }

            // Apply filter
            if (currentFilter === 'flac') {
                results = results.filter(track => track.codec === 'FLAC');
            } else if (currentFilter === 'hq') {
                results = results.filter(track => track.bitrate >= 320000);
            } else if (currentFilter === 'recent') {
                results = results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 100);
            }

            filteredTracks = results;
            renderTracks();
        }

        function playTrack(index) {
            currentTrackIndex = index;
            const track = filteredTracks[index];
            
            // Update now playing display
            document.getElementById('npTitle').textContent = track.title || track.name;
            document.getElementById('npArtist').textContent = track.artist || 'Unknown Artist';
            document.getElementById('npAlbum').textContent = track.album || '-';
            document.getElementById('totalTime').textContent = formatDuration(track.duration);
            document.getElementById('nowPlaying').classList.add('active');
            
            isPlaying = true;
            document.getElementById('playPauseBtn').textContent = '⏸';
            
            renderTracks();
        }

        function togglePlayPause() {
            if (currentTrackIndex === -1) {
                playTrack(0);
                return;
            }
            
            isPlaying = !isPlaying;
            document.getElementById('playPauseBtn').textContent = isPlaying ? '⏸' : '▶';
        }

        function previousTrack() {
            if (currentTrackIndex > 0) {
                playTrack(currentTrackIndex - 1);
            }
        }

        function nextTrack() {
            if (currentTrackIndex < filteredTracks.length - 1) {
                playTrack(currentTrackIndex + 1);
            }
        }

        function toggleShuffle() {
            alert('Shuffle functionality would be implemented here');
        }

        function toggleRepeat() {
            alert('Repeat functionality would be implemented here');
        }

        function seekTo(event) {
            const bar = document.getElementById('progressBar');
            const percent = (event.clientX - bar.getBoundingClientRect().left) / bar.offsetWidth;
            document.getElementById('progressFill').style.width = (percent * 100) + '%';
        }

        function selectPlaylist(id) {
            document.querySelectorAll('.playlist-item').forEach(item => item.classList.remove('active'));
            event.target.closest('.playlist-item').classList.add('active');
        }

        // Event listeners
        document.getElementById('searchInput').addEventListener('input', applyFilters);

        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                currentFilter = this.dataset.filter;
                applyFilters();
            });
        });

        // Simulate progress (in real implementation, this would sync with actual audio playback)
        setInterval(() => {
            if (isPlaying && currentTrackIndex >= 0) {
                const currentProgress = parseFloat(document.getElementById('progressFill').style.width) || 0;
                const newProgress = Math.min(currentProgress + 0.5, 100);
                document.getElementById('progressFill').style.width = newProgress + '%';
                
                const track = filteredTracks[currentTrackIndex];
                const currentSeconds = (newProgress / 100) * track.duration;
                document.getElementById('currentTime').textContent = formatDuration(currentSeconds);
                
                // Auto-advance to next track
                if (newProgress >= 100) {
                    nextTrack();
                }
            }
        }, 1000);

        // Initial render
        renderPlaylists();
        renderTracks();
    </script>
</body>
</html>`;
  }
}
