import { PhotoLibraryGenerator } from './lib/photo-ui.js';
import { MusicPlayerGenerator } from './lib/music-ui.js';
import { MoviePlayerGenerator } from './lib/movie-ui.js';
import { formatBytes } from './lib/utils.js';
import fs from 'fs/promises';

// Sample photo data
const samplePhotos = [
  {
    id: 1,
    path: '/photos/vacation/beach_sunset.jpg',
    name: 'beach_sunset.jpg',
    size: 4523840,
    width: 4032,
    height: 3024,
    format: 'jpeg',
    camera_make: 'Canon',
    camera_model: 'EOS 5D Mark IV',
    lens_model: 'EF 24-70mm f/2.8L',
    iso: 200,
    aperture: 5.6,
    shutter_speed: '1/250',
    focal_length: 50,
    date_taken: '2024-08-15 18:30:00',
    latitude: 34.0522,
    longitude: -118.2437,
    altitude: 10
  },
  {
    id: 2,
    path: '/photos/nature/mountain_view.jpg',
    name: 'mountain_view.jpg',
    size: 6234567,
    width: 6000,
    height: 4000,
    format: 'jpeg',
    camera_make: 'Nikon',
    camera_model: 'D850',
    iso: 100,
    aperture: 8,
    shutter_speed: '1/125',
    focal_length: 24,
    date_taken: '2024-07-20 10:15:00',
    latitude: 46.8523,
    longitude: 8.6322,
    altitude: 2800
  },
  {
    id: 3,
    path: '/photos/family/birthday_party.jpg',
    name: 'birthday_party.jpg',
    size: 3456789,
    width: 3840,
    height: 2160,
    format: 'jpeg',
    camera_make: 'Sony',
    camera_model: 'A7 III',
    iso: 800,
    aperture: 2.8,
    shutter_speed: '1/60',
    focal_length: 35,
    date_taken: '2024-09-05 15:45:00'
  },
  {
    id: 4,
    path: '/photos/cityscape/downtown_night.jpg',
    name: 'downtown_night.jpg',
    size: 5678901,
    width: 7360,
    height: 4912,
    format: 'jpeg',
    camera_make: 'Canon',
    camera_model: 'EOS R5',
    iso: 3200,
    aperture: 1.8,
    shutter_speed: '1/30',
    focal_length: 85,
    date_taken: '2024-10-12 21:00:00',
    latitude: 40.7128,
    longitude: -74.0060
  },
  {
    id: 5,
    path: '/photos/wildlife/eagle_flight.jpg',
    name: 'eagle_flight.jpg',
    size: 8901234,
    width: 8256,
    height: 5504,
    format: 'jpeg',
    camera_make: 'Nikon',
    camera_model: 'D6',
    lens_model: 'AF-S 600mm f/4E FL',
    iso: 1600,
    aperture: 4,
    shutter_speed: '1/2000',
    focal_length: 600,
    date_taken: '2024-06-18 08:30:00'
  }
];

const photoStats = {
  totalPhotos: samplePhotos.length,
  totalSize: formatBytes(samplePhotos.reduce((sum, p) => sum + p.size, 0)),
  uniqueCameras: 4,
  withGPS: 3
};

// Sample music data
const sampleTracks = [
  {
    id: 1,
    path: '/music/rock/01-yesterday.mp3',
    name: '01-yesterday.mp3',
    size: 5242880,
    title: 'Yesterday',
    artist: 'The Beatles',
    album: 'Help!',
    album_artist: 'The Beatles',
    year: 1965,
    genre: 'Rock',
    track_number: 1,
    track_total: 14,
    duration: 183.5,
    bitrate: 320000,
    sample_rate: 44100,
    channels: 2,
    codec: 'MP3',
    has_album_art: true,
    created_at: '2024-01-15'
  },
  {
    id: 2,
    path: '/music/jazz/take_five.flac',
    name: 'take_five.flac',
    size: 28311552,
    title: 'Take Five',
    artist: 'Dave Brubeck Quartet',
    album: 'Time Out',
    year: 1959,
    genre: 'Jazz',
    track_number: 3,
    duration: 324.2,
    bitrate: 1411200,
    sample_rate: 44100,
    channels: 2,
    codec: 'FLAC',
    has_album_art: true,
    created_at: '2024-02-20'
  },
  {
    id: 3,
    path: '/music/classical/moonlight_sonata.mp3',
    name: 'moonlight_sonata.mp3',
    size: 8388608,
    title: 'Piano Sonata No. 14 "Moonlight"',
    artist: 'Ludwig van Beethoven',
    album: 'Beethoven: Piano Sonatas',
    year: 1801,
    genre: 'Classical',
    track_number: 14,
    duration: 362.8,
    bitrate: 256000,
    sample_rate: 44100,
    channels: 2,
    codec: 'MP3',
    composer: 'Ludwig van Beethoven',
    has_album_art: true,
    created_at: '2024-03-10'
  },
  {
    id: 4,
    path: '/music/electronic/strobe.mp3',
    name: 'strobe.mp3',
    size: 10485760,
    title: 'Strobe',
    artist: 'deadmau5',
    album: 'For Lack of a Better Name',
    year: 2009,
    genre: 'Electronic',
    track_number: 7,
    duration: 634.5,
    bitrate: 192000,
    sample_rate: 44100,
    channels: 2,
    codec: 'MP3',
    has_album_art: true,
    created_at: '2024-04-05'
  },
  {
    id: 5,
    path: '/music/pop/shape_of_you.mp3',
    name: 'shape_of_you.mp3',
    size: 4718592,
    title: 'Shape of You',
    artist: 'Ed Sheeran',
    album: '÷ (Divide)',
    year: 2017,
    genre: 'Pop',
    track_number: 4,
    duration: 233.7,
    bitrate: 256000,
    sample_rate: 44100,
    channels: 2,
    codec: 'MP3',
    has_album_art: true,
    created_at: '2024-05-12'
  }
];

const musicStats = {
  totalTracks: sampleTracks.length,
  totalAlbums: 5,
  totalArtists: 5,
  totalDuration: '29m 59s',
  totalSize: formatBytes(sampleTracks.reduce((sum, t) => sum + t.size, 0))
};

// Sample movie data
const sampleMovies = [
  {
    id: 1,
    path: '/movies/action/the_matrix.mkv',
    name: 'the_matrix.mkv',
    size: 5368709120,
    title: 'The Matrix',
    duration: 8160,
    width: 1920,
    height: 1080,
    frame_rate: 23.976,
    video_codec: 'H.264',
    video_bitrate: 5000000,
    audio_codec: 'AAC',
    audio_bitrate: 192000,
    audio_channels: 6,
    description: 'A computer hacker learns about the true nature of reality.',
    genre: 'Sci-Fi, Action',
    year: 1999,
    create_date: '1999-03-31',
    created_at: '2024-01-10'
  },
  {
    id: 2,
    path: '/movies/drama/inception.mp4',
    name: 'inception.mp4',
    size: 10737418240,
    title: 'Inception',
    duration: 8880,
    width: 3840,
    height: 2160,
    frame_rate: 24,
    video_codec: 'H.265',
    video_bitrate: 10000000,
    audio_codec: 'DTS',
    audio_bitrate: 1536000,
    audio_channels: 8,
    description: 'A thief who steals corporate secrets through dream-sharing technology.',
    genre: 'Sci-Fi, Thriller',
    year: 2010,
    create_date: '2010-07-16',
    software: 'HandBrake',
    created_at: '2024-02-15'
  },
  {
    id: 3,
    path: '/movies/comedy/the_grand_budapest_hotel.mkv',
    name: 'the_grand_budapest_hotel.mkv',
    size: 3221225472,
    title: 'The Grand Budapest Hotel',
    duration: 6000,
    width: 1920,
    height: 1080,
    frame_rate: 24,
    video_codec: 'H.264',
    video_bitrate: 4000000,
    audio_codec: 'AAC',
    audio_bitrate: 256000,
    audio_channels: 2,
    description: 'The adventures of Gustave H, a concierge at a famous hotel.',
    genre: 'Comedy, Drama',
    year: 2014,
    create_date: '2014-03-07',
    created_at: '2024-03-20'
  },
  {
    id: 4,
    path: '/movies/animation/spirited_away.mp4',
    name: 'spirited_away.mp4',
    size: 2684354560,
    title: 'Spirited Away',
    duration: 7500,
    width: 1280,
    height: 720,
    frame_rate: 23.976,
    video_codec: 'H.264',
    video_bitrate: 2500000,
    audio_codec: 'AAC',
    audio_bitrate: 128000,
    audio_channels: 2,
    description: 'A young girl enters a magical world ruled by a witch.',
    genre: 'Animation, Fantasy',
    year: 2001,
    create_date: '2001-07-20',
    created_at: '2024-04-08'
  },
  {
    id: 5,
    path: '/movies/thriller/parasite.mkv',
    name: 'parasite.mkv',
    size: 8589934592,
    title: 'Parasite',
    duration: 7920,
    width: 3840,
    height: 2160,
    frame_rate: 24,
    video_codec: 'H.265',
    video_bitrate: 8000000,
    audio_codec: 'DTS',
    audio_bitrate: 768000,
    audio_channels: 6,
    description: 'Greed and class discrimination threaten the newly formed symbiotic relationship.',
    genre: 'Thriller, Drama',
    year: 2019,
    create_date: '2019-05-30',
    created_at: '2024-05-18'
  }
];

const movieStats = {
  totalMovies: sampleMovies.length,
  totalDuration: '10h 38m',
  totalSize: formatBytes(sampleMovies.reduce((sum, m) => sum + m.size, 0)),
  hdCount: 3,
  fourKCount: 2
};

// Generate sample files
async function generateSamples() {
  console.log('Generating sample UI files...');
  
  const photoHTML = PhotoLibraryGenerator.generateHTML(samplePhotos, photoStats);
  await fs.writeFile('sample-photo-library.html', photoHTML);
  console.log('✓ Generated sample-photo-library.html');
  
  const musicHTML = MusicPlayerGenerator.generateHTML(sampleTracks, musicStats);
  await fs.writeFile('sample-music-player.html', musicHTML);
  console.log('✓ Generated sample-music-player.html');
  
  const movieHTML = MoviePlayerGenerator.generateHTML(sampleMovies, movieStats);
  await fs.writeFile('sample-movie-player.html', movieHTML);
  console.log('✓ Generated sample-movie-player.html');
  
  console.log('\n✅ All sample files generated successfully!');
}

generateSamples().catch(console.error);
