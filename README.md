# SilverFileSystem

A powerful Node.js file management system inspired by [Czkawka](https://github.com/qarmin/czkawka) for managing and analyzing files across your network.

## Features

- 🔍 **Duplicate File Finder** - Find duplicate files by comparing content hashes
- 📁 **Empty Files & Directories** - Locate empty files and directories
- 📊 **Large Files Finder** - Find and list large files consuming disk space
- 🔗 **Broken Symlinks Detector** - Find broken symbolic links
- ⚠️ **Invalid Names Finder** - Detect files with problematic names
- 🌐 **Network Support** - Scan files across network paths and drives
- ⚡ **Fast Scanning** - Optimized file scanning with quick hash support
- 🎨 **Beautiful CLI** - Colorful and user-friendly command-line interface

## Installation

### Install from source

```bash
git clone https://github.com/NeoSilver997/SilverFileSystem.git
cd SilverFileSystem
npm install
```

### Link globally (optional)

```bash
npm link
```

This allows you to use the `silverfs` command from anywhere.

## Usage

### Basic Commands

#### Scan Directory Overview
Get a quick overview of a directory:

```bash
node bin/cli.js scan <directory>
```

Example:
```bash
node bin/cli.js scan /path/to/folder
```

#### Find Duplicate Files
Find duplicate files in one or more directories:

```bash
node bin/cli.js duplicates <path1> [path2] [path3...]
```

Options:
- `-m, --min-size <bytes>` - Minimum file size to check (default: 0)
- `-q, --quick` - Use quick hash for faster scanning

Examples:
```bash
# Find all duplicates in a directory
node bin/cli.js duplicates /path/to/folder

# Find duplicates larger than 1MB (1048576 bytes)
node bin/cli.js duplicates /path/to/folder -m 1048576

# Scan multiple directories
node bin/cli.js duplicates /path/folder1 /path/folder2
```

#### Find Empty Files
Find empty files (0 bytes):

```bash
node bin/cli.js empty-files <path1> [path2...]
```

Example:
```bash
node bin/cli.js empty-files /path/to/folder
```

#### Find Empty Directories
Find empty directories:

```bash
node bin/cli.js empty-dirs <path1> [path2...]
```

Example:
```bash
node bin/cli.js empty-dirs /path/to/folder
```

#### Find Large Files
Find large files consuming disk space:

```bash
node bin/cli.js large-files <path1> [path2...]
```

Options:
- `-m, --min-size <MB>` - Minimum file size in MB (default: 100)
- `-l, --limit <number>` - Maximum number of results (default: 50)

Examples:
```bash
# Find files larger than 100MB
node bin/cli.js large-files /path/to/folder

# Find files larger than 500MB, show top 20
node bin/cli.js large-files /path/to/folder -m 500 -l 20
```

#### Find Broken Symbolic Links
Find broken symbolic links that point to non-existent targets:

```bash
node bin/cli.js broken-symlinks <path1> [path2...]
```

Example:
```bash
node bin/cli.js broken-symlinks /path/to/folder
```

#### Find Invalid File Names
Find files with invalid or problematic names (special characters, trailing spaces, etc.):

```bash
node bin/cli.js invalid-names <path1> [path2...]
```

Example:
```bash
node bin/cli.js invalid-names /path/to/folder
```

## Network Usage

SilverFileSystem can scan files across network paths:

### Windows (UNC Paths)
```bash
node bin/cli.js scan "\\\\server\\share\\folder"
node bin/cli.js duplicates "\\\\server\\share"
```

### Linux/Mac (Mounted Network Drives)
```bash
node bin/cli.js scan /mnt/network/folder
node bin/cli.js duplicates /mnt/network1 /mnt/network2
```

## API Usage

You can also use SilverFileSystem as a library in your Node.js projects:

```javascript
import { FileScanner } from './lib/scanner.js';
import { DuplicateFinder } from './lib/duplicates.js';
import { EmptyFinder } from './lib/empty.js';
import { LargeFilesFinder } from './lib/large.js';

// Scan a directory
const scanner = new FileScanner();
const files = await scanner.scanDirectory('/path/to/folder');

// Find duplicates
const finder = new DuplicateFinder(scanner);
const duplicates = await finder.findDuplicates(['/path/to/folder']);

// Find empty files
const emptyFinder = new EmptyFinder();
const emptyFiles = await emptyFinder.findEmptyFiles('/path/to/folder');

// Find large files
const largeFinder = new LargeFilesFinder(scanner);
const largeFiles = await largeFinder.findLargeFiles(['/path/to/folder'], { 
  minSize: 100 * 1024 * 1024 // 100 MB 
});
```

## Performance Tips

1. **Use Quick Hash**: For initial duplicate scanning, use the `-q` flag for faster results
2. **Set Minimum Size**: Use `-m` option to skip small files and speed up scanning
3. **Limit Results**: Use `-l` option when finding large files to reduce processing time
4. **Network Paths**: Scanning network drives may be slower due to network latency

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

ISC

## Inspired By

This project is inspired by [Czkawka](https://github.com/qarmin/czkawka), a powerful file management application written in Rust.
