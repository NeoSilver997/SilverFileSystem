import { test, describe } from 'node:test';
import assert from 'node:assert';
import { MediaMetadataExtractor } from '../lib/media.js';

describe('MediaMetadataExtractor Module', () => {
  
  describe('getExtension', () => {
    test('should extract extension from filename', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.getExtension('file.txt'), 'txt');
      assert.strictEqual(extractor.getExtension('document.pdf'), 'pdf');
      assert.strictEqual(extractor.getExtension('image.png'), 'png');
    });

    test('should handle files with multiple dots', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.getExtension('archive.tar.gz'), 'gz');
      assert.strictEqual(extractor.getExtension('my.file.name.txt'), 'txt');
    });

    test('should handle files without extension', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.getExtension('README'), '');
      assert.strictEqual(extractor.getExtension('Makefile'), '');
    });

    test('should convert to lowercase', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.getExtension('FILE.TXT'), 'txt');
      assert.strictEqual(extractor.getExtension('IMAGE.JPG'), 'jpg');
    });

    test('should handle empty string', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.getExtension(''), '');
    });
  });

  describe('isImage', () => {
    test('should identify common image formats', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isImage('photo.jpg'), true);
      assert.strictEqual(extractor.isImage('image.jpeg'), true);
      assert.strictEqual(extractor.isImage('picture.png'), true);
      assert.strictEqual(extractor.isImage('graphic.gif'), true);
      assert.strictEqual(extractor.isImage('bitmap.bmp'), true);
      assert.strictEqual(extractor.isImage('photo.tiff'), true);
      assert.strictEqual(extractor.isImage('pic.webp'), true);
    });

    test('should identify Apple image formats', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isImage('photo.heic'), true);
      assert.strictEqual(extractor.isImage('photo.heif'), true);
    });

    test('should be case insensitive', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isImage('PHOTO.JPG'), true);
      assert.strictEqual(extractor.isImage('Image.PNG'), true);
    });

    test('should return false for non-image files', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isImage('document.pdf'), false);
      assert.strictEqual(extractor.isImage('song.mp3'), false);
      assert.strictEqual(extractor.isImage('video.mp4'), false);
      assert.strictEqual(extractor.isImage('file.txt'), false);
    });

    test('should return false for files without extension', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isImage('README'), false);
      assert.strictEqual(extractor.isImage(''), false);
    });
  });

  describe('isAudio', () => {
    test('should identify common audio formats', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isAudio('song.mp3'), true);
      assert.strictEqual(extractor.isAudio('music.flac'), true);
      assert.strictEqual(extractor.isAudio('audio.wav'), true);
      assert.strictEqual(extractor.isAudio('track.aac'), true);
      assert.strictEqual(extractor.isAudio('tune.m4a'), true);
      assert.strictEqual(extractor.isAudio('sound.ogg'), true);
      assert.strictEqual(extractor.isAudio('music.wma'), true);
      assert.strictEqual(extractor.isAudio('audio.opus'), true);
    });

    test('should be case insensitive', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isAudio('SONG.MP3'), true);
      assert.strictEqual(extractor.isAudio('Music.FLAC'), true);
    });

    test('should return false for non-audio files', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isAudio('document.pdf'), false);
      assert.strictEqual(extractor.isAudio('photo.jpg'), false);
      assert.strictEqual(extractor.isAudio('video.mp4'), false);
      assert.strictEqual(extractor.isAudio('file.txt'), false);
    });

    test('should return false for files without extension', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isAudio('README'), false);
      assert.strictEqual(extractor.isAudio(''), false);
    });
  });

  describe('isVideo', () => {
    test('should identify common video formats', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isVideo('movie.mp4'), true);
      assert.strictEqual(extractor.isVideo('video.mkv'), true);
      assert.strictEqual(extractor.isVideo('clip.avi'), true);
      assert.strictEqual(extractor.isVideo('film.mov'), true);
      assert.strictEqual(extractor.isVideo('video.wmv'), true);
      assert.strictEqual(extractor.isVideo('clip.flv'), true);
      assert.strictEqual(extractor.isVideo('movie.webm'), true);
      assert.strictEqual(extractor.isVideo('video.m4v'), true);
      assert.strictEqual(extractor.isVideo('film.mpeg'), true);
    });

    test('should be case insensitive', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isVideo('MOVIE.MP4'), true);
      assert.strictEqual(extractor.isVideo('Video.MKV'), true);
    });

    test('should return false for non-video files', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isVideo('document.pdf'), false);
      assert.strictEqual(extractor.isVideo('photo.jpg'), false);
      assert.strictEqual(extractor.isVideo('song.mp3'), false);
      assert.strictEqual(extractor.isVideo('file.txt'), false);
    });

    test('should return false for files without extension', () => {
      const extractor = new MediaMetadataExtractor();
      
      assert.strictEqual(extractor.isVideo('README'), false);
      assert.strictEqual(extractor.isVideo(''), false);
    });
  });

  describe('Media type detection integration', () => {
    test('should correctly categorize different file types', () => {
      const extractor = new MediaMetadataExtractor();
      
      // Images
      assert.strictEqual(extractor.isImage('photo.jpg'), true);
      assert.strictEqual(extractor.isAudio('photo.jpg'), false);
      assert.strictEqual(extractor.isVideo('photo.jpg'), false);
      
      // Audio
      assert.strictEqual(extractor.isImage('song.mp3'), false);
      assert.strictEqual(extractor.isAudio('song.mp3'), true);
      assert.strictEqual(extractor.isVideo('song.mp3'), false);
      
      // Video
      assert.strictEqual(extractor.isImage('movie.mp4'), false);
      assert.strictEqual(extractor.isAudio('movie.mp4'), false);
      assert.strictEqual(extractor.isVideo('movie.mp4'), true);
    });

    test('should handle edge case extensions', () => {
      const extractor = new MediaMetadataExtractor();
      
      // M4A can be both audio and video container, but typically audio
      assert.strictEqual(extractor.isAudio('song.m4a'), true);
      
      // M4V is video variant of M4A
      assert.strictEqual(extractor.isVideo('movie.m4v'), true);
    });
  });
});
