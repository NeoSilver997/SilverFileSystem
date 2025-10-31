import { formatBytes } from './utils.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * HTML Report Generator for Duplicate Files
 */
export class ReportGenerator {
  /**
   * Generate an interactive HTML report for duplicate files
   */
  async generateDuplicateReport(duplicateGroups, outputPath) {
    const totalGroups = duplicateGroups.length;
    const totalFiles = duplicateGroups.reduce((sum, group) => sum + group.count, 0);
    const totalWastedSpace = duplicateGroups.reduce((sum, group) => sum + group.wastedSpace, 0);
    
    const html = this.buildHtmlReport(duplicateGroups, {
      totalGroups,
      totalFiles,
      totalWastedSpace
    });

    await fs.writeFile(outputPath, html, 'utf8');
    return outputPath;
  }

  /**
   * Generate an HTML report for duplicate files grouped by name and size
   */
  async generateNameSizeDuplicateReport(duplicateGroups, outputPath) {
    const totalGroups = duplicateGroups.length;
    const totalFiles = duplicateGroups.reduce((sum, group) => sum + group.count, 0);
    const totalWastedSpace = duplicateGroups.reduce((sum, group) => sum + group.wastedSpace, 0);
    
    const html = this.buildNameSizeHtmlReport(duplicateGroups, {
      totalGroups,
      totalFiles,
      totalWastedSpace
    });

    await fs.writeFile(outputPath, html, 'utf8');
    return outputPath;
  }

  /**
   * Generate an HTML report for duplicate files grouped by folder
   */
  async generateFolderDuplicateReport(folderGroups, outputPath) {
    const totalFolders = folderGroups.length;
    const totalFiles = folderGroups.reduce((sum, folder) => sum + folder.totalFiles, 0);
    const totalWastedSpace = folderGroups.reduce((sum, folder) => sum + folder.totalWastedSpace, 0);
    
    const html = this.buildFolderHtmlReport(folderGroups, {
      totalFolders,
      totalFiles,
      totalWastedSpace
    });

    await fs.writeFile(outputPath, html, 'utf8');
    return outputPath;
  }

  /**
   * Build the HTML report content
   */
  buildHtmlReport(duplicateGroups, stats) {
    const groupsHtml = duplicateGroups.map((group, index) => 
      this.buildGroupHtml(group, index)
    ).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Duplicate Files Report - SilverFileSystem</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }

        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            font-weight: 700;
        }

        .header p {
            font-size: 1.1em;
            opacity: 0.9;
        }

        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            padding: 30px 40px;
            background: #f8f9fa;
            border-bottom: 2px solid #e9ecef;
        }

        .stat-card {
            background: white;
            padding: 25px;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            text-align: center;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .stat-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        }

        .stat-card .value {
            font-size: 2.5em;
            font-weight: 700;
            color: #667eea;
            margin-bottom: 5px;
        }

        .stat-card .label {
            color: #6c757d;
            font-size: 0.95em;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .controls {
            padding: 30px 40px;
            background: white;
            border-bottom: 2px solid #e9ecef;
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            align-items: center;
        }

        .search-box {
            flex: 1;
            min-width: 250px;
        }

        .search-box input {
            width: 100%;
            padding: 12px 20px;
            border: 2px solid #e9ecef;
            border-radius: 8px;
            font-size: 1em;
            transition: border-color 0.2s;
        }

        .search-box input:focus {
            outline: none;
            border-color: #667eea;
        }

        .filter-buttons {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }

        .btn {
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            font-size: 0.95em;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }

        .btn-primary {
            background: #667eea;
            color: white;
        }

        .btn-primary:hover {
            background: #5568d3;
            transform: translateY(-2px);
        }

        .btn-secondary {
            background: #e9ecef;
            color: #495057;
        }

        .btn-secondary:hover {
            background: #dee2e6;
        }

        .content {
            padding: 40px;
        }

        .duplicate-group {
            background: #f8f9fa;
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 25px;
            border-left: 5px solid #667eea;
            transition: all 0.3s;
        }

        .duplicate-group:hover {
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            transform: translateX(5px);
        }

        .group-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #dee2e6;
            cursor: pointer;
            user-select: none;
        }

        .group-info {
            display: flex;
            gap: 30px;
            align-items: center;
            flex-wrap: wrap;
        }

        .group-title {
            font-size: 1.3em;
            font-weight: 700;
            color: #495057;
        }

        .badge {
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 0.9em;
            font-weight: 600;
        }

        .badge-files {
            background: #667eea;
            color: white;
        }

        .badge-size {
            background: #28a745;
            color: white;
        }

        .badge-wasted {
            background: #dc3545;
            color: white;
        }

        .toggle-icon {
            font-size: 1.5em;
            color: #667eea;
            transition: transform 0.3s;
        }

        .group-header.collapsed .toggle-icon {
            transform: rotate(-90deg);
        }

        .file-list {
            display: grid;
            gap: 12px;
        }

        .file-list.collapsed {
            display: none;
        }

        .file-item {
            background: white;
            padding: 15px 20px;
            border-radius: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 15px;
            transition: all 0.2s;
        }

        .file-item:hover {
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            transform: translateX(5px);
        }

        .file-path {
            flex: 1;
            font-family: 'Courier New', monospace;
            font-size: 0.9em;
            color: #495057;
            word-break: break-all;
        }

        .file-date {
            color: #6c757d;
            font-size: 0.85em;
            white-space: nowrap;
        }

        .hash-display {
            font-family: 'Courier New', monospace;
            font-size: 0.8em;
            color: #6c757d;
            margin-top: 10px;
            padding: 10px;
            background: white;
            border-radius: 6px;
        }

        .no-results {
            text-align: center;
            padding: 60px 20px;
            color: #6c757d;
        }

        .no-results-icon {
            font-size: 4em;
            margin-bottom: 20px;
        }

        .footer {
            background: #f8f9fa;
            padding: 20px;
            text-align: center;
            color: #6c757d;
            font-size: 0.9em;
            border-top: 2px solid #e9ecef;
        }

        @media (max-width: 768px) {
            .header h1 {
                font-size: 1.8em;
            }

            .stats {
                grid-template-columns: 1fr;
            }

            .controls {
                flex-direction: column;
                align-items: stretch;
            }

            .filter-buttons {
                justify-content: stretch;
            }

            .btn {
                flex: 1;
            }

            .group-info {
                flex-direction: column;
                align-items: flex-start;
                gap: 10px;
            }

            .file-item {
                flex-direction: column;
                align-items: flex-start;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔍 Duplicate Files Report</h1>
            <p>Generated by SilverFileSystem</p>
        </div>

        <div class="stats">
            <div class="stat-card">
                <div class="value">${stats.totalGroups}</div>
                <div class="label">Duplicate Groups</div>
            </div>
            <div class="stat-card">
                <div class="value">${stats.totalFiles}</div>
                <div class="label">Total Files</div>
            </div>
            <div class="stat-card">
                <div class="value">${formatBytes(stats.totalWastedSpace)}</div>
                <div class="label">Wasted Space</div>
            </div>
        </div>

        <div class="controls">
            <div class="search-box">
                <input type="text" id="searchInput" placeholder="🔎 Search files by path or name...">
            </div>
            <div class="filter-buttons">
                <button class="btn btn-primary" onclick="expandAll()">Expand All</button>
                <button class="btn btn-secondary" onclick="collapseAll()">Collapse All</button>
                <button class="btn btn-secondary" onclick="sortBySize()">Sort by Size</button>
                <button class="btn btn-secondary" onclick="sortByCount()">Sort by Count</button>
            </div>
        </div>

        <div class="content" id="duplicatesContainer">
            ${groupsHtml}
        </div>

        <div class="footer">
            Generated on ${new Date().toLocaleString()} | SilverFileSystem v1.0.0
        </div>
    </div>

    <script>
        // Toggle group visibility
        function toggleGroup(groupId) {
            const header = document.getElementById('header-' + groupId);
            const fileList = document.getElementById('files-' + groupId);
            
            header.classList.toggle('collapsed');
            fileList.classList.toggle('collapsed');
        }

        // Expand all groups
        function expandAll() {
            document.querySelectorAll('.group-header').forEach(header => {
                header.classList.remove('collapsed');
            });
            document.querySelectorAll('.file-list').forEach(list => {
                list.classList.remove('collapsed');
            });
        }

        // Collapse all groups
        function collapseAll() {
            document.querySelectorAll('.group-header').forEach(header => {
                header.classList.add('collapsed');
            });
            document.querySelectorAll('.file-list').forEach(list => {
                list.classList.add('collapsed');
            });
        }

        // Search functionality
        document.getElementById('searchInput').addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            const groups = document.querySelectorAll('.duplicate-group');
            let visibleCount = 0;

            groups.forEach(group => {
                const text = group.textContent.toLowerCase();
                if (text.includes(searchTerm)) {
                    group.style.display = 'block';
                    visibleCount++;
                } else {
                    group.style.display = 'none';
                }
            });

            // Show no results message
            const container = document.getElementById('duplicatesContainer');
            let noResults = document.getElementById('noResults');
            
            if (visibleCount === 0 && searchTerm) {
                if (!noResults) {
                    noResults = document.createElement('div');
                    noResults.id = 'noResults';
                    noResults.className = 'no-results';
                    noResults.innerHTML = '<div class="no-results-icon">🔍</div><h2>No results found</h2><p>Try a different search term</p>';
                    container.appendChild(noResults);
                }
                noResults.style.display = 'block';
            } else if (noResults) {
                noResults.style.display = 'none';
            }
        });

        // Sort by size
        function sortBySize() {
            const container = document.getElementById('duplicatesContainer');
            const groups = Array.from(container.querySelectorAll('.duplicate-group'));
            
            groups.sort((a, b) => {
                const sizeA = parseInt(a.getAttribute('data-size'));
                const sizeB = parseInt(b.getAttribute('data-size'));
                return sizeB - sizeA;
            });

            groups.forEach(group => container.appendChild(group));
        }

        // Sort by count
        function sortByCount() {
            const container = document.getElementById('duplicatesContainer');
            const groups = Array.from(container.querySelectorAll('.duplicate-group'));
            
            groups.sort((a, b) => {
                const countA = parseInt(a.getAttribute('data-count'));
                const countB = parseInt(b.getAttribute('data-count'));
                return countB - countA;
            });

            groups.forEach(group => container.appendChild(group));
        }

        // Initialize with all groups collapsed
        collapseAll();
    </script>
</body>
</html>`;
  }

  /**
   * Build HTML for a single duplicate group
   */
  buildGroupHtml(group, index) {
    const filesHtml = group.files.map(file => this.buildFileHtml(file)).join('\n');
    
    return `
            <div class="duplicate-group" data-size="${group.size}" data-count="${group.count}">
                <div class="group-header" id="header-${index}" onclick="toggleGroup(${index})">
                    <div class="group-info">
                        <span class="group-title">Group ${index + 1}</span>
                        <span class="badge badge-files">${group.count} files</span>
                        <span class="badge badge-size">${formatBytes(group.size)} each</span>
                        <span class="badge badge-wasted">⚠️ ${formatBytes(group.wastedSpace)} wasted</span>
                    </div>
                    <span class="toggle-icon">▼</span>
                </div>
                <div class="file-list" id="files-${index}">
                    ${filesHtml}
                    <div class="hash-display">
                        <strong>Hash:</strong> ${group.hash}
                    </div>
                </div>
            </div>`;
  }

  /**
   * Build HTML for a single file
   */
  buildFileHtml(file) {
    const date = file.mtime ? new Date(file.mtime).toLocaleString() : 'Unknown';
    
    return `
                    <div class="file-item">
                        <span class="file-path">${this.escapeHtml(file.path)}</span>
                        <span class="file-date">${date}</span>
                    </div>`;
  }

  /**
   * Build the folder-grouped HTML report content
   */
  buildFolderHtmlReport(folderGroups, stats) {
    const foldersHtml = folderGroups.map((folder, index) => 
      this.buildFolderHtml(folder, index)
    ).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Duplicate Files by Folder Report - SilverFileSystem</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            background: #f5f5f5;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px 0;
            text-align: center;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
            font-weight: 700;
        }

        .header p {
            font-size: 1.1rem;
            opacity: 0.9;
        }

        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            padding: 30px 40px;
            background: #f8f9fa;
            border-bottom: 2px solid #e9ecef;
        }

        .stat-card {
            background: white;
            padding: 25px;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            text-align: center;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .stat-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 4px 25px rgba(0, 0, 0, 0.15);
        }

        .stat-number {
            font-size: 2.5rem;
            font-weight: bold;
            color: #667eea;
            display: block;
        }

        .stat-label {
            font-size: 1rem;
            color: #666;
            margin-top: 5px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 30px 20px;
        }

        .folder-group {
            background: white;
            border-radius: 12px;
            margin-bottom: 30px;
            box-shadow: 0 2px 15px rgba(0, 0, 0, 0.1);
            overflow: hidden;
            transition: box-shadow 0.3s ease;
        }

        .folder-group:hover {
            box-shadow: 0 4px 25px rgba(0, 0, 0, 0.15);
        }

        .folder-header {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
            padding: 20px 25px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .folder-header:hover {
            background: linear-gradient(135deg, #f5576c 0%, #f093fb 100%);
        }

        .folder-path {
            font-size: 1.1rem;
            font-weight: 600;
            word-break: break-all;
        }

        .folder-stats {
            display: flex;
            gap: 20px;
            align-items: center;
        }

        .folder-stat {
            text-align: center;
        }

        .folder-stat-number {
            font-size: 1.2rem;
            font-weight: bold;
            display: block;
        }

        .folder-stat-label {
            font-size: 0.8rem;
            opacity: 0.9;
        }

        .folder-content {
            display: none;
            padding: 0;
        }

        .folder-content.active {
            display: block;
        }

        .duplicate-group {
            border-bottom: 1px solid #eee;
            padding: 20px 25px;
        }

        .duplicate-group:last-child {
            border-bottom: none;
        }

        .group-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 2px solid #f1f3f4;
        }

        .group-info {
            display: flex;
            gap: 20px;
            align-items: center;
        }

        .file-hash {
            font-family: 'Courier New', monospace;
            font-size: 0.85rem;
            color: #666;
            background: #f8f9fa;
            padding: 4px 8px;
            border-radius: 4px;
        }

        .group-stats {
            display: flex;
            gap: 15px;
            font-size: 0.9rem;
            color: #666;
        }

        .files-list {
            margin-left: 20px;
        }

        .file-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 12px;
            margin: 5px 0;
            background: #f8f9fa;
            border-radius: 6px;
            border-left: 4px solid #667eea;
        }

        .file-path {
            font-family: 'Courier New', monospace;
            font-size: 0.9rem;
            word-break: break-all;
            flex: 1;
        }

        .file-date {
            font-size: 0.85rem;
            color: #666;
            margin-left: 15px;
        }

        .toggle-icon {
            transition: transform 0.3s ease;
            font-size: 1.2rem;
        }

        .toggle-icon.rotated {
            transform: rotate(180deg);
        }

        .no-folders {
            text-align: center;
            padding: 60px 20px;
            color: #666;
        }

        .no-folders h2 {
            color: #999;
            margin-bottom: 10px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📁 Duplicate Files by Folder</h1>
        <p>Organized view of duplicate files grouped by their containing folders</p>
    </div>

    <div class="stats">
        <div class="stat-card">
            <span class="stat-number">${stats.totalFolders}</span>
            <div class="stat-label">Folders with Duplicates</div>
        </div>
        <div class="stat-card">
            <span class="stat-number">${stats.totalFiles}</span>
            <div class="stat-label">Duplicate Files</div>
        </div>
        <div class="stat-card">
            <span class="stat-number">${formatBytes(stats.totalWastedSpace)}</span>
            <div class="stat-label">Total Wasted Space</div>
        </div>
    </div>

    <div class="container">
        ${folderGroups.length > 0 ? foldersHtml : `
        <div class="no-folders">
            <h2>No duplicate files found</h2>
            <p>Your file system is clean - no duplicates detected in any folders!</p>
        </div>
        `}
    </div>

    <script>
        // Toggle folder content visibility
        document.querySelectorAll('.folder-header').forEach(header => {
            header.addEventListener('click', () => {
                const content = header.nextElementSibling;
                const icon = header.querySelector('.toggle-icon');
                
                content.classList.toggle('active');
                icon.classList.toggle('rotated');
            });
        });

        // Auto-expand folders with significant wasted space
        document.querySelectorAll('.folder-group').forEach(group => {
            const wastedSpaceText = group.querySelector('.folder-stat-number').textContent;
            if (wastedSpaceText.includes('GB') || 
                (wastedSpaceText.includes('MB') && parseFloat(wastedSpaceText) > 100)) {
                const header = group.querySelector('.folder-header');
                const content = group.querySelector('.folder-content');
                const icon = group.querySelector('.toggle-icon');
                
                content.classList.add('active');
                icon.classList.add('rotated');
            }
        });
    </script>
</body>
</html>`;
  }

  /**
   * Build HTML for a single folder group
   */
  buildFolderHtml(folder, index) {
    const duplicateGroupsHtml = folder.duplicateGroups.map((group, groupIndex) => 
      this.buildFolderDuplicateGroupHtml(group, groupIndex)
    ).join('\n');

    return `
        <div class="folder-group">
            <div class="folder-header">
                <div class="folder-path">${this.escapeHtml(folder.folderPath)}</div>
                <div class="folder-stats">
                    <div class="folder-stat">
                        <span class="folder-stat-number">${folder.totalFiles}</span>
                        <div class="folder-stat-label">Files</div>
                    </div>
                    <div class="folder-stat">
                        <span class="folder-stat-number">${formatBytes(folder.totalWastedSpace)}</span>
                        <div class="folder-stat-label">Wasted Space</div>
                    </div>
                    <span class="toggle-icon">▼</span>
                </div>
            </div>
            <div class="folder-content">
                ${duplicateGroupsHtml}
            </div>
        </div>`;
  }

  /**
   * Build HTML for a duplicate group within a folder
   */
  buildFolderDuplicateGroupHtml(group, index) {
    const filesHtml = group.files.map(file => this.buildFolderFileHtml(file)).join('\n');
    
    return `
            <div class="duplicate-group">
                <div class="group-header">
                    <div class="group-info">
                        <span class="file-hash">${group.hash.substring(0, 12)}...</span>
                        <span>${formatBytes(group.size)}</span>
                    </div>
                    <div class="group-stats">
                        <span>${group.files.length} copies in this folder</span>
                        <span>•</span>
                        <span>${group.count} total copies</span>
                        <span>•</span>
                        <span class="wasted-space">${formatBytes((group.files.length - 1) * group.size)} wasted</span>
                    </div>
                </div>
                <div class="files-list">
                    ${filesHtml}
                </div>
            </div>`;
  }

  /**
   * Build HTML for a single file in folder view
   */
  buildFolderFileHtml(file) {
    return `
                    <div class="file-item">
                        <span class="file-path">${this.escapeHtml(file.name)}</span>
                        <span class="file-date">Full path: ${this.escapeHtml(file.path)}</span>
                    </div>`;
  }

  /**
   * Build HTML report for duplicates by name and size
   */
  buildNameSizeHtmlReport(duplicateGroups, stats) {
    const groupsHtml = duplicateGroups.map((group, index) => 
      this.buildNameSizeGroupHtml(group, index)
    ).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Duplicate Files by Name & Size - SilverFileSystem</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }

        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            font-weight: 700;
        }

        .header p {
            font-size: 1.1em;
            opacity: 0.9;
        }

        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            padding: 30px 40px;
            background: #f8f9fa;
            border-bottom: 2px solid #e9ecef;
        }

        .stat-card {
            background: white;
            padding: 25px;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            text-align: center;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .stat-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        }

        .stat-card .value {
            font-size: 2.5em;
            font-weight: 700;
            color: #667eea;
            margin-bottom: 5px;
        }

        .stat-card .label {
            color: #6c757d;
            font-size: 0.95em;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .controls {
            padding: 30px 40px;
            background: white;
            border-bottom: 2px solid #e9ecef;
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            align-items: center;
        }

        .search-box {
            flex: 1;
            min-width: 250px;
        }

        .search-box input {
            width: 100%;
            padding: 12px 20px;
            border: 2px solid #e9ecef;
            border-radius: 8px;
            font-size: 1em;
            transition: border-color 0.2s;
        }

        .search-box input:focus {
            outline: none;
            border-color: #667eea;
        }

        .filter-buttons {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }

        .btn {
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            font-size: 0.95em;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }

        .btn-primary {
            background: #667eea;
            color: white;
        }

        .btn-primary:hover {
            background: #5568d3;
            transform: translateY(-2px);
        }

        .btn-secondary {
            background: #e9ecef;
            color: #495057;
        }

        .btn-secondary:hover {
            background: #dee2e6;
        }

        .content {
            padding: 40px;
        }

        .duplicate-group {
            background: #f8f9fa;
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 25px;
            border-left: 5px solid #667eea;
            transition: all 0.3s;
        }

        .duplicate-group:hover {
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            transform: translateX(5px);
        }

        .group-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #dee2e6;
            cursor: pointer;
            user-select: none;
        }

        .group-info {
            display: flex;
            gap: 30px;
            align-items: center;
            flex-wrap: wrap;
        }

        .group-title {
            font-size: 1.3em;
            font-weight: 700;
            color: #495057;
            word-break: break-all;
        }

        .badge {
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 0.9em;
            font-weight: 600;
        }

        .badge-files {
            background: #667eea;
            color: white;
        }

        .badge-size {
            background: #28a745;
            color: white;
        }

        .badge-wasted {
            background: #dc3545;
            color: white;
        }

        .toggle-icon {
            font-size: 1.5em;
            color: #667eea;
            transition: transform 0.3s;
        }

        .group-header.collapsed .toggle-icon {
            transform: rotate(-90deg);
        }

        .file-list {
            display: grid;
            gap: 12px;
        }

        .file-list.collapsed {
            display: none;
        }

        .file-item {
            background: white;
            padding: 15px 20px;
            border-radius: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 15px;
            transition: all 0.2s;
        }

        .file-item:hover {
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            transform: translateX(5px);
        }

        .file-path {
            flex: 1;
            font-family: 'Courier New', monospace;
            font-size: 0.9em;
            color: #495057;
            word-break: break-all;
        }

        .file-date {
            color: #6c757d;
            font-size: 0.85em;
            white-space: nowrap;
        }

        .no-results {
            text-align: center;
            padding: 60px 20px;
            color: #6c757d;
        }

        .no-results-icon {
            font-size: 4em;
            margin-bottom: 20px;
        }

        .footer {
            background: #f8f9fa;
            padding: 20px;
            text-align: center;
            color: #6c757d;
            font-size: 0.9em;
            border-top: 2px solid #e9ecef;
        }

        @media (max-width: 768px) {
            .header h1 {
                font-size: 1.8em;
            }

            .stats {
                grid-template-columns: 1fr;
            }

            .controls {
                flex-direction: column;
                align-items: stretch;
            }

            .filter-buttons {
                justify-content: stretch;
            }

            .btn {
                flex: 1;
            }

            .group-info {
                flex-direction: column;
                align-items: flex-start;
                gap: 10px;
            }

            .file-item {
                flex-direction: column;
                align-items: flex-start;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📁 Duplicate Files by Name & Size</h1>
            <p>Files with same name and size in different locations</p>
        </div>

        <div class="stats">
            <div class="stat-card">
                <div class="value">${stats.totalGroups}</div>
                <div class="label">Duplicate File Names</div>
            </div>
            <div class="stat-card">
                <div class="value">${stats.totalFiles}</div>
                <div class="label">Total Files</div>
            </div>
            <div class="stat-card">
                <div class="value">${formatBytes(stats.totalWastedSpace)}</div>
                <div class="label">Wasted Space</div>
            </div>
        </div>

        <div class="controls">
            <div class="search-box">
                <input type="text" id="searchInput" placeholder="🔎 Search by filename or path...">
            </div>
            <div class="filter-buttons">
                <button class="btn btn-primary" onclick="expandAll()">Expand All</button>
                <button class="btn btn-secondary" onclick="collapseAll()">Collapse All</button>
                <button class="btn btn-secondary" onclick="sortBySize()">Sort by Size</button>
                <button class="btn btn-secondary" onclick="sortByCount()">Sort by Count</button>
            </div>
        </div>

        <div class="content" id="duplicatesContainer">
            ${groupsHtml}
        </div>

        <div class="footer">
            Generated on ${new Date().toLocaleString()} | SilverFileSystem v1.0.0
        </div>
    </div>

    <script>
        // Toggle group visibility
        function toggleGroup(groupId) {
            const header = document.getElementById('header-' + groupId);
            const fileList = document.getElementById('files-' + groupId);
            
            header.classList.toggle('collapsed');
            fileList.classList.toggle('collapsed');
        }

        // Expand all groups
        function expandAll() {
            document.querySelectorAll('.group-header').forEach(header => {
                header.classList.remove('collapsed');
            });
            document.querySelectorAll('.file-list').forEach(list => {
                list.classList.remove('collapsed');
            });
        }

        // Collapse all groups
        function collapseAll() {
            document.querySelectorAll('.group-header').forEach(header => {
                header.classList.add('collapsed');
            });
            document.querySelectorAll('.file-list').forEach(list => {
                list.classList.add('collapsed');
            });
        }

        // Search functionality
        document.getElementById('searchInput').addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            const groups = document.querySelectorAll('.duplicate-group');
            let visibleCount = 0;

            groups.forEach(group => {
                const text = group.textContent.toLowerCase();
                if (text.includes(searchTerm)) {
                    group.style.display = 'block';
                    visibleCount++;
                } else {
                    group.style.display = 'none';
                }
            });

            // Show no results message
            const container = document.getElementById('duplicatesContainer');
            let noResults = document.getElementById('noResults');
            
            if (visibleCount === 0 && searchTerm) {
                if (!noResults) {
                    noResults = document.createElement('div');
                    noResults.id = 'noResults';
                    noResults.className = 'no-results';
                    noResults.innerHTML = '<div class="no-results-icon">🔍</div><h2>No results found</h2><p>Try a different search term</p>';
                    container.appendChild(noResults);
                }
                noResults.style.display = 'block';
            } else if (noResults) {
                noResults.style.display = 'none';
            }
        });

        // Sort by size
        function sortBySize() {
            const container = document.getElementById('duplicatesContainer');
            const groups = Array.from(container.querySelectorAll('.duplicate-group'));
            
            groups.sort((a, b) => {
                const sizeA = parseInt(a.getAttribute('data-size'));
                const sizeB = parseInt(b.getAttribute('data-size'));
                return sizeB - sizeA;
            });

            groups.forEach(group => container.appendChild(group));
        }

        // Sort by count
        function sortByCount() {
            const container = document.getElementById('duplicatesContainer');
            const groups = Array.from(container.querySelectorAll('.duplicate-group'));
            
            groups.sort((a, b) => {
                const countA = parseInt(a.getAttribute('data-count'));
                const countB = parseInt(b.getAttribute('data-count'));
                return countB - countA;
            });

            groups.forEach(group => container.appendChild(group));
        }

        // Initialize with all groups collapsed
        collapseAll();
    </script>
</body>
</html>`;
  }

  /**
   * Build HTML for a single duplicate group (name+size)
   */
  buildNameSizeGroupHtml(group, index) {
    const filesHtml = group.files.map(file => this.buildNameSizeFileHtml(file)).join('\n');
    
    return `
            <div class="duplicate-group" data-size="${group.size}" data-count="${group.count}">
                <div class="group-header" id="header-${index}" onclick="toggleGroup(${index})">
                    <div class="group-info">
                        <span class="group-title">${this.escapeHtml(group.name)}</span>
                        <span class="badge badge-files">${group.count} locations</span>
                        <span class="badge badge-size">${formatBytes(group.size)} each</span>
                        <span class="badge badge-wasted">⚠️ ${formatBytes(group.wastedSpace)} wasted</span>
                    </div>
                    <span class="toggle-icon">▼</span>
                </div>
                <div class="file-list" id="files-${index}">
                    ${filesHtml}
                </div>
            </div>`;
  }

  /**
   * Build HTML for a single file (name+size report)
   */
  buildNameSizeFileHtml(file) {
    const date = file.mtime ? new Date(file.mtime).toLocaleString() : 'Unknown';
    
    return `
                    <div class="file-item">
                        <span class="file-path">${this.escapeHtml(file.path)}</span>
                        <span class="file-date">${date}</span>
                    </div>`;
  }

  /**
   * Escape HTML special characters
   */
  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }
}
