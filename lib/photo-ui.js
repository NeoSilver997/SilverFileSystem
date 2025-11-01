/**
 * Photo Library UI Generator
 * Creates an interactive web interface for browsing photos with metadata
 */
export class PhotoLibraryGenerator {
  /**
   * Generate the photo library HTML
   * @param {Array} photos - Array of photo data with metadata
   * @param {Object} stats - Statistics about the photo collection
   * @returns {string} HTML content
   */
  static generateHTML(photos, stats) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Photo Library - SilverFileSystem</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #f5f7fa;
            color: #2c3e50;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 2rem;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 0.5rem;
            font-weight: 700;
        }

        .header p {
            font-size: 1.1rem;
            opacity: 0.9;
        }

        .stats-bar {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
            padding: 2rem;
            background: white;
            border-bottom: 2px solid #e9ecef;
        }

        .stat-card {
            text-align: center;
            padding: 1rem;
        }

        .stat-number {
            font-size: 2rem;
            font-weight: bold;
            color: #667eea;
        }

        .stat-label {
            font-size: 0.9rem;
            color: #666;
            margin-top: 0.3rem;
        }

        .controls {
            background: white;
            padding: 1.5rem 2rem;
            border-bottom: 1px solid #e9ecef;
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
            border: 2px solid #e9ecef;
            border-radius: 8px;
            font-size: 1rem;
            transition: border-color 0.3s;
        }

        .search-box input:focus {
            outline: none;
            border-color: #667eea;
        }

        .filter-group {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
        }

        .filter-btn {
            padding: 0.75rem 1.5rem;
            border: 2px solid #e9ecef;
            background: white;
            border-radius: 8px;
            cursor: pointer;
            font-size: 0.9rem;
            transition: all 0.3s;
        }

        .filter-btn:hover {
            border-color: #667eea;
            color: #667eea;
        }

        .filter-btn.active {
            background: #667eea;
            color: white;
            border-color: #667eea;
        }

        .view-toggle {
            display: flex;
            gap: 0.5rem;
        }

        .view-btn {
            padding: 0.75rem 1rem;
            border: 2px solid #e9ecef;
            background: white;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s;
        }

        .view-btn.active {
            background: #667eea;
            color: white;
            border-color: #667eea;
        }

        .container {
            padding: 2rem;
            max-width: 1600px;
            margin: 0 auto;
        }

        .gallery-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 1.5rem;
        }

        .gallery-list {
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }

        .photo-card {
            background: white;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            transition: transform 0.3s, box-shadow 0.3s;
            cursor: pointer;
        }

        .photo-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        }

        .photo-thumbnail {
            width: 100%;
            aspect-ratio: 4/3;
            background: #f0f0f0;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
        }

        .photo-thumbnail img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .photo-icon {
            font-size: 3rem;
            color: #ccc;
        }

        .photo-info {
            padding: 1rem;
        }

        .photo-name {
            font-weight: 600;
            margin-bottom: 0.5rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .photo-meta {
            font-size: 0.85rem;
            color: #666;
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }

        .photo-badge {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            background: #e9ecef;
            border-radius: 4px;
            font-size: 0.75rem;
            margin-right: 0.25rem;
        }

        .list-card {
            background: white;
            border-radius: 8px;
            padding: 1.5rem;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            display: grid;
            grid-template-columns: auto 1fr auto;
            gap: 1.5rem;
            align-items: center;
            cursor: pointer;
            transition: all 0.3s;
        }

        .list-card:hover {
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        }

        .list-thumbnail {
            width: 120px;
            height: 90px;
            border-radius: 8px;
            background: #f0f0f0;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }

        .list-thumbnail img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .list-info {
            flex: 1;
        }

        .list-title {
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
        }

        .list-details {
            display: flex;
            flex-wrap: wrap;
            gap: 1rem;
            font-size: 0.9rem;
            color: #666;
        }

        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.95);
            z-index: 1000;
            align-items: center;
            justify-content: center;
        }

        .modal.active {
            display: flex;
        }

        .modal-content {
            max-width: 90%;
            max-height: 90%;
            position: relative;
        }

        .modal-image {
            max-width: 100%;
            max-height: 80vh;
            object-fit: contain;
        }

        .modal-info {
            background: white;
            padding: 1.5rem;
            border-radius: 8px;
            margin-top: 1rem;
            max-height: 40vh;
            overflow-y: auto;
        }

        .modal-close {
            position: absolute;
            top: -3rem;
            right: 0;
            background: white;
            border: none;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 1.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .modal-nav {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            background: white;
            border: none;
            width: 50px;
            height: 50px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 1.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .modal-prev {
            left: -70px;
        }

        .modal-next {
            right: -70px;
        }

        .metadata-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
            margin-top: 1rem;
        }

        .metadata-item {
            display: flex;
            flex-direction: column;
        }

        .metadata-label {
            font-size: 0.8rem;
            color: #666;
            margin-bottom: 0.25rem;
        }

        .metadata-value {
            font-weight: 600;
        }

        .no-results {
            text-align: center;
            padding: 4rem 2rem;
            color: #666;
        }

        .no-results h2 {
            font-size: 2rem;
            margin-bottom: 1rem;
        }

        @media (max-width: 768px) {
            .gallery-grid {
                grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
                gap: 1rem;
            }

            .controls {
                flex-direction: column;
                align-items: stretch;
            }

            .search-box {
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📷 Photo Library</h1>
        <p>Browse and explore your photo collection with metadata</p>
    </div>

    <div class="stats-bar">
        <div class="stat-card">
            <div class="stat-number">${stats.totalPhotos || 0}</div>
            <div class="stat-label">Total Photos</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.totalSize || '0 B'}</div>
            <div class="stat-label">Total Size</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.uniqueCameras || 0}</div>
            <div class="stat-label">Cameras Used</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${stats.withGPS || 0}</div>
            <div class="stat-label">With GPS Data</div>
        </div>
    </div>

    <div class="controls">
        <div class="search-box">
            <input type="text" id="searchInput" placeholder="Search photos by name, camera, location...">
        </div>
        <div class="filter-group">
            <button class="filter-btn active" data-filter="all">All</button>
            <button class="filter-btn" data-filter="gps">With GPS</button>
            <button class="filter-btn" data-filter="portrait">Portrait</button>
            <button class="filter-btn" data-filter="landscape">Landscape</button>
        </div>
        <div class="view-toggle">
            <button class="view-btn active" data-view="grid">Grid</button>
            <button class="view-btn" data-view="list">List</button>
        </div>
    </div>

    <div class="container">
        <div id="photoContainer" class="gallery-grid"></div>
    </div>

    <div id="photoModal" class="modal">
        <div class="modal-content">
            <button class="modal-close" onclick="closeModal()">✕</button>
            <button class="modal-nav modal-prev" onclick="navigatePhoto(-1)">‹</button>
            <button class="modal-nav modal-next" onclick="navigatePhoto(1)">›</button>
            <img id="modalImage" class="modal-image" src="" alt="">
            <div class="modal-info" id="modalInfo"></div>
        </div>
    </div>

    <script>
        const photosData = ${JSON.stringify(photos)};
        let filteredPhotos = [...photosData];
        let currentView = 'grid';
        let currentFilter = 'all';
        let currentPhotoIndex = -1;

        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        function formatDate(dateString) {
            if (!dateString) return 'N/A';
            const date = new Date(dateString);
            return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
        }

        function renderPhotos() {
            const container = document.getElementById('photoContainer');
            container.className = currentView === 'grid' ? 'gallery-grid' : 'gallery-list';
            
            if (filteredPhotos.length === 0) {
                container.innerHTML = \`
                    <div class="no-results">
                        <h2>No photos found</h2>
                        <p>Try adjusting your search or filters</p>
                    </div>
                \`;
                return;
            }

            if (currentView === 'grid') {
                container.innerHTML = filteredPhotos.map((photo, index) => \`
                    <div class="photo-card" onclick="openModal(\${index})">
                        <div class="photo-thumbnail">
                            <span class="photo-icon">📷</span>
                        </div>
                        <div class="photo-info">
                            <div class="photo-name" title="\${photo.name}">\${photo.name}</div>
                            <div class="photo-meta">
                                <div>\${photo.width || 0}×\${photo.height || 0} • \${formatBytes(photo.size)}</div>
                                \${photo.camera_make ? \`<div>📸 \${photo.camera_make} \${photo.camera_model || ''}</div>\` : ''}
                                \${photo.date_taken ? \`<div>📅 \${formatDate(photo.date_taken)}</div>\` : ''}
                                \${photo.latitude ? \`<span class="photo-badge">📍 GPS</span>\` : ''}
                            </div>
                        </div>
                    </div>
                \`).join('');
            } else {
                container.innerHTML = filteredPhotos.map((photo, index) => \`
                    <div class="list-card" onclick="openModal(\${index})">
                        <div class="list-thumbnail">
                            <span class="photo-icon">📷</span>
                        </div>
                        <div class="list-info">
                            <div class="list-title">\${photo.name}</div>
                            <div class="list-details">
                                <span>\${photo.width || 0}×\${photo.height || 0}</span>
                                <span>\${formatBytes(photo.size)}</span>
                                \${photo.camera_make ? \`<span>📸 \${photo.camera_make} \${photo.camera_model || ''}</span>\` : ''}
                                \${photo.date_taken ? \`<span>📅 \${formatDate(photo.date_taken)}</span>\` : ''}
                                \${photo.latitude ? \`<span>📍 GPS: \${photo.latitude.toFixed(4)}, \${photo.longitude.toFixed(4)}</span>\` : ''}
                            </div>
                        </div>
                    </div>
                \`).join('');
            }
        }

        function applyFilters() {
            let results = photosData;
            const searchTerm = document.getElementById('searchInput').value.toLowerCase();

            // Apply search
            if (searchTerm) {
                results = results.filter(photo => 
                    photo.name.toLowerCase().includes(searchTerm) ||
                    (photo.camera_make && photo.camera_make.toLowerCase().includes(searchTerm)) ||
                    (photo.camera_model && photo.camera_model.toLowerCase().includes(searchTerm)) ||
                    (photo.path && photo.path.toLowerCase().includes(searchTerm))
                );
            }

            // Apply filter
            if (currentFilter === 'gps') {
                results = results.filter(photo => photo.latitude !== null);
            } else if (currentFilter === 'portrait') {
                results = results.filter(photo => photo.height > photo.width);
            } else if (currentFilter === 'landscape') {
                results = results.filter(photo => photo.width > photo.height);
            }

            filteredPhotos = results;
            renderPhotos();
        }

        function openModal(index) {
            currentPhotoIndex = index;
            const photo = filteredPhotos[index];
            const modal = document.getElementById('photoModal');
            const modalImage = document.getElementById('modalImage');
            const modalInfo = document.getElementById('modalInfo');

            // Set modal content
            modalImage.src = 'file://' + photo.path;
            modalImage.alt = photo.name;

            modalInfo.innerHTML = \`
                <h2>\${photo.name}</h2>
                <div class="metadata-grid">
                    <div class="metadata-item">
                        <div class="metadata-label">Dimensions</div>
                        <div class="metadata-value">\${photo.width || 0} × \${photo.height || 0}</div>
                    </div>
                    <div class="metadata-item">
                        <div class="metadata-label">Size</div>
                        <div class="metadata-value">\${formatBytes(photo.size)}</div>
                    </div>
                    <div class="metadata-item">
                        <div class="metadata-label">Format</div>
                        <div class="metadata-value">\${photo.format || 'N/A'}</div>
                    </div>
                    \${photo.camera_make ? \`
                        <div class="metadata-item">
                            <div class="metadata-label">Camera</div>
                            <div class="metadata-value">\${photo.camera_make} \${photo.camera_model || ''}</div>
                        </div>
                    \` : ''}
                    \${photo.lens_model ? \`
                        <div class="metadata-item">
                            <div class="metadata-label">Lens</div>
                            <div class="metadata-value">\${photo.lens_model}</div>
                        </div>
                    \` : ''}
                    \${photo.iso ? \`
                        <div class="metadata-item">
                            <div class="metadata-label">ISO</div>
                            <div class="metadata-value">\${photo.iso}</div>
                        </div>
                    \` : ''}
                    \${photo.aperture ? \`
                        <div class="metadata-item">
                            <div class="metadata-label">Aperture</div>
                            <div class="metadata-value">f/\${photo.aperture}</div>
                        </div>
                    \` : ''}
                    \${photo.shutter_speed ? \`
                        <div class="metadata-item">
                            <div class="metadata-label">Shutter Speed</div>
                            <div class="metadata-value">\${photo.shutter_speed}</div>
                        </div>
                    \` : ''}
                    \${photo.focal_length ? \`
                        <div class="metadata-item">
                            <div class="metadata-label">Focal Length</div>
                            <div class="metadata-value">\${photo.focal_length}mm</div>
                        </div>
                    \` : ''}
                    \${photo.date_taken ? \`
                        <div class="metadata-item">
                            <div class="metadata-label">Date Taken</div>
                            <div class="metadata-value">\${formatDate(photo.date_taken)}</div>
                        </div>
                    \` : ''}
                    \${photo.latitude ? \`
                        <div class="metadata-item">
                            <div class="metadata-label">GPS Location</div>
                            <div class="metadata-value">\${photo.latitude.toFixed(6)}, \${photo.longitude.toFixed(6)}</div>
                        </div>
                    \` : ''}
                    \${photo.altitude ? \`
                        <div class="metadata-item">
                            <div class="metadata-label">Altitude</div>
                            <div class="metadata-value">\${photo.altitude.toFixed(1)}m</div>
                        </div>
                    \` : ''}
                    <div class="metadata-item" style="grid-column: 1/-1;">
                        <div class="metadata-label">File Path</div>
                        <div class="metadata-value" style="word-break: break-all;">\${photo.path}</div>
                    </div>
                </div>
            \`;

            modal.classList.add('active');
        }

        function closeModal() {
            document.getElementById('photoModal').classList.remove('active');
        }

        function navigatePhoto(direction) {
            currentPhotoIndex += direction;
            if (currentPhotoIndex < 0) currentPhotoIndex = filteredPhotos.length - 1;
            if (currentPhotoIndex >= filteredPhotos.length) currentPhotoIndex = 0;
            openModal(currentPhotoIndex);
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

        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                currentView = this.dataset.view;
                renderPhotos();
            });
        });

        document.getElementById('photoModal').addEventListener('click', function(e) {
            if (e.target === this) closeModal();
        });

        document.addEventListener('keydown', function(e) {
            const modal = document.getElementById('photoModal');
            if (modal.classList.contains('active')) {
                if (e.key === 'Escape') closeModal();
                else if (e.key === 'ArrowLeft') navigatePhoto(-1);
                else if (e.key === 'ArrowRight') navigatePhoto(1);
            }
        });

        // Initial render
        renderPhotos();
    </script>
</body>
</html>`;
  }
}
