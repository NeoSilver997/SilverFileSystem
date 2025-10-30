import { parseFile } from 'music-metadata';
import sharp from 'sharp';
import { exiftool } from 'exiftool-vendored';
import path from 'path';

/**
 * Media Metadata Extractor
 * Extracts detailed information from photos, music, and video files
 */
export class MediaMetadataExtractor {
  constructor() {
    this.imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp', 'heic', 'heif'];
    this.audioExtensions = ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'wma', 'opus'];
    this.videoExtensions = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg'];
  }

  /**
   * Get file extension
   */
  getExtension(filename) {
    const ext = path.extname(filename).toLowerCase().slice(1);
    return ext;
  }

  /**
   * Check if file is an image
   */
  isImage(filename) {
    const ext = this.getExtension(filename);
    return this.imageExtensions.includes(ext);
  }

  /**
   * Check if file is audio
   */
  isAudio(filename) {
    const ext = this.getExtension(filename);
    return this.audioExtensions.includes(ext);
  }

  /**
   * Check if file is video
   */
  isVideo(filename) {
    const ext = this.getExtension(filename);
    return this.videoExtensions.includes(ext);
  }

  /**
   * Extract photo metadata
   */
  async extractPhotoMetadata(filePath) {
    try {
      const metadata = {};

      // Use sharp for image dimensions and basic info
      const image = sharp(filePath);
      const imageMetadata = await image.metadata();

      metadata.width = imageMetadata.width;
      metadata.height = imageMetadata.height;
      metadata.format = imageMetadata.format;
      metadata.space = imageMetadata.space;
      metadata.channels = imageMetadata.channels;
      metadata.depth = imageMetadata.depth;
      metadata.density = imageMetadata.density;
      metadata.hasAlpha = imageMetadata.hasAlpha;
      metadata.orientation = imageMetadata.orientation;

      // Use exiftool for EXIF data
      try {
        const exif = await exiftool.read(filePath);
        
        metadata.camera = {
          make: exif.Make,
          model: exif.Model,
          lens: exif.LensModel
        };

        metadata.settings = {
          iso: exif.ISO,
          aperture: exif.FNumber || exif.ApertureValue,
          shutterSpeed: exif.ExposureTime || exif.ShutterSpeedValue,
          focalLength: exif.FocalLength,
          flash: exif.Flash
        };

        metadata.datetime = {
          taken: exif.DateTimeOriginal || exif.CreateDate,
          modified: exif.ModifyDate
        };

        metadata.location = {
          latitude: exif.GPSLatitude,
          longitude: exif.GPSLongitude,
          altitude: exif.GPSAltitude
        };

        metadata.software = exif.Software;
        metadata.artist = exif.Artist;
        metadata.copyright = exif.Copyright;
        metadata.description = exif.ImageDescription;
      } catch (err) {
        // EXIF data might not be available
        console.warn(`Could not read EXIF for ${filePath}: ${err.message}`);
      }

      return metadata;
    } catch (err) {
      console.warn(`Error extracting photo metadata from ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Extract music metadata
   */
  async extractMusicMetadata(filePath) {
    try {
      const metadata = await parseFile(filePath);
      
      return {
        // Format info
        format: {
          container: metadata.format.container,
          codec: metadata.format.codec,
          sampleRate: metadata.format.sampleRate,
          bitrate: metadata.format.bitrate,
          numberOfChannels: metadata.format.numberOfChannels,
          duration: metadata.format.duration
        },

        // Track info
        track: {
          title: metadata.common.title,
          artist: metadata.common.artist,
          artists: metadata.common.artists,
          album: metadata.common.album,
          albumArtist: metadata.common.albumartist,
          year: metadata.common.year,
          genre: metadata.common.genre,
          trackNumber: metadata.common.track?.no,
          trackTotal: metadata.common.track?.of,
          diskNumber: metadata.common.disk?.no,
          diskTotal: metadata.common.disk?.of
        },

        // Additional info
        comment: metadata.common.comment,
        composer: metadata.common.composer,
        conductor: metadata.common.conductor,
        lyrics: metadata.common.lyrics,
        isrc: metadata.common.isrc,
        copyright: metadata.common.copyright,
        encodedBy: metadata.common.encodedby,
        encodingSettings: metadata.common.encodersettings,

        // Album art info
        hasAlbumArt: metadata.common.picture && metadata.common.picture.length > 0,
        albumArtCount: metadata.common.picture?.length || 0
      };
    } catch (err) {
      console.warn(`Error extracting music metadata from ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Extract video metadata
   */
  async extractVideoMetadata(filePath) {
    try {
      const exif = await exiftool.read(filePath);

      return {
        // Video properties
        video: {
          duration: exif.Duration,
          width: exif.ImageWidth,
          height: exif.ImageHeight,
          frameRate: exif.VideoFrameRate || exif.FrameRate,
          bitrate: exif.VideoBitrate,
          codec: exif.VideoCodec || exif.CompressorID
        },

        // Audio properties
        audio: {
          codec: exif.AudioCodec,
          sampleRate: exif.AudioSampleRate,
          channels: exif.AudioChannels,
          bitrate: exif.AudioBitrate
        },

        // Metadata
        title: exif.Title,
        description: exif.Description,
        comment: exif.Comment,
        genre: exif.Genre,
        artist: exif.Artist,
        album: exif.Album,
        year: exif.Year,
        track: exif.Track,

        // Dates
        createDate: exif.CreateDate,
        modifyDate: exif.ModifyDate,
        dateTimeOriginal: exif.DateTimeOriginal,

        // Technical details
        fileType: exif.FileType,
        mimeType: exif.MIMEType,
        software: exif.Software,
        encoder: exif.Encoder,

        // Location (if available)
        location: {
          latitude: exif.GPSLatitude,
          longitude: exif.GPSLongitude,
          altitude: exif.GPSAltitude
        }
      };
    } catch (err) {
      console.warn(`Error extracting video metadata from ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Extract metadata based on file type
   */
  async extractMetadata(filePath) {
    const filename = path.basename(filePath);

    if (this.isImage(filename)) {
      return {
        type: 'photo',
        metadata: await this.extractPhotoMetadata(filePath)
      };
    } else if (this.isAudio(filename)) {
      return {
        type: 'music',
        metadata: await this.extractMusicMetadata(filePath)
      };
    } else if (this.isVideo(filename)) {
      return {
        type: 'video',
        metadata: await this.extractVideoMetadata(filePath)
      };
    }

    return null;
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    try {
      await exiftool.end();
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}
