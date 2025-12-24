import axios from 'axios';
import Parser from 'srt-parser-2';

import { getAllConfigs } from '@/shared/models/config';
import { getStorageService } from '@/shared/services/storage';

export type Platform = 'youtube' | 'tiktok';

export interface MediaMetadata {
  title?: string;
  author?: string;
  duration?: number;
  likes?: number;
  views?: number;
  shares?: number;
  publishedAt?: Date;
  thumbnailUrl?: string;
  sourceLang?: string;
}

export interface SrtItem {
  id: number;
  startTime: string;
  endTime: string;
  text: string;
}

/**
 * MediaProcessor handles video extraction, subtitle generation, and translation
 */
export class MediaProcessor {
  private rapidApiKey: string;
  private googleTranslateApiKey: string;

  constructor(rapidApiKey: string, googleTranslateApiKey: string) {
    this.rapidApiKey = rapidApiKey;
    this.googleTranslateApiKey = googleTranslateApiKey;
  }

  /**
   * Resolve TikTok short links to full URLs
   */
  async resolveTikTokShortLink(url: string): Promise<string> {
    try {
      const response = await axios.head(url, {
        maxRedirects: 2,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      // If redirected, get the final URL
      if (response.request?.responseURL) {
        return response.request.responseURL;
      }

      return url;
    } catch (error) {
      // If resolution fails, return original URL
      // RapidAPI may handle short links internally
      console.warn('Failed to resolve TikTok short link:', error);
      return url;
    }
  }

  /**
   * Extract YouTube video ID from URL
   */
  extractYouTubeId(url: string): string | null {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Extract metadata and subtitles from YouTube video
   */
  async extractYouTubeMetadata(
    videoId: string
  ): Promise<{ metadata: MediaMetadata; srtItems: SrtItem[] }> {
    const url = `https://youtube-transcriptor.p.rapidapi.com/transcript?video_id=${videoId}&lang=en`;

    // Retry logic for RapidAPI rate limiting (429 errors)
    const retries = 3;
    let response: any;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        response = await axios.get(url, {
          headers: {
            'x-rapidapi-host': 'youtube-transcriptor.p.rapidapi.com',
            'x-rapidapi-key': this.rapidApiKey,
          },
          timeout: 60000, // 60 seconds timeout
        });
        break; // Success, exit retry loop
      } catch (error: any) {
        const isLastAttempt = attempt === retries - 1;
        const shouldRetry =
          error.response?.status === 429 || error.response?.status === 500;

        if (isLastAttempt || !shouldRetry) {
          const statusCode = error.response?.status;
          const errorMessage = statusCode === 429
            ? `YouTube extraction failed: Rate limit exceeded (429). Please wait a moment and try again.`
            : `YouTube extraction failed: ${error.response?.data?.message || error.message || 'Unknown error'}`;
          throw new Error(errorMessage);
        }

        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.pow(2, attempt + 1) * 1000;
        console.log(`YouTube API attempt ${attempt + 1}/${retries} failed (${error.response?.status || 'error'}), waiting ${delay / 1000}s before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Parse response and convert to SRT format
    const transcript = response.data;
    const srtItems: SrtItem[] = [];

    if (Array.isArray(transcript)) {
      transcript.forEach((item: any, index: number) => {
        srtItems.push({
          id: index + 1,
          startTime: this.formatTime(item.start || 0),
          endTime: this.formatTime(item.start + (item.dur || 0)),
          text: item.text || '',
        });
      });
    }

    const metadata: MediaMetadata = {
      title: response.data.title,
      sourceLang: response.data.language || 'en',
      thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    };

    return { metadata, srtItems };
  }

  /**
   * Fetch TikTok data from RapidAPI (extracted for easy endpoint switching)
   */
  private async fetchTikTokData(url: string): Promise<any> {
    // Resolve short links first
    const resolvedUrl = await this.resolveTikTokShortLink(url);

    // Current endpoint: tiktok-transcriptor-api3
    // Can be easily switched to other endpoints like:
    // - tiktok-full-info-without-watermark
    // - social-media-video-downloader
    
    // Retry logic for RapidAPI rate limiting (429 errors)
    const retries = 3;
    let response: any;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        response = await axios.post(
          'https://tiktok-transcriptor-api3.p.rapidapi.com/index.php',
          { url: resolvedUrl },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-rapidapi-host': 'tiktok-transcriptor-api3.p.rapidapi.com',
              'x-rapidapi-key': this.rapidApiKey,
            },
            timeout: 60000, // 60 seconds timeout
          }
        );
        break; // Success, exit retry loop
      } catch (error: any) {
        const isLastAttempt = attempt === retries - 1;
        const statusCode = error.response?.status;
        const shouldRetry = statusCode === 429 || statusCode === 500;

        console.log(`TikTok API attempt ${attempt + 1}/${retries}: ${statusCode ? `Status ${statusCode}` : error.message}`);

        if (isLastAttempt || !shouldRetry) {
          const errorMessage = statusCode === 429
            ? `TikTok extraction failed: Rate limit exceeded (429). Please wait a moment and try again.`
            : `TikTok extraction failed: ${error.response?.data?.message || error.message || 'Unknown error'}`;
          throw new Error(errorMessage);
        }

        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.pow(2, attempt + 1) * 1000;
        console.log(`Waiting ${delay / 1000}s before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return response.data;
  }

  /**
   * Extract metadata and subtitles from TikTok video
   */
  async extractTikTokMetadata(
    url: string
  ): Promise<{ metadata: MediaMetadata; srtItems: SrtItem[] }> {
    const data = await this.fetchTikTokData(url);
    const srtItems: SrtItem[] = [];

    // Parse transcript data
    if (data.transcript && Array.isArray(data.transcript)) {
      data.transcript.forEach((item: any, index: number) => {
        srtItems.push({
          id: index + 1,
          startTime: this.formatTime(item.start || 0),
          endTime: this.formatTime(item.start + (item.duration || 0)),
          text: item.text || '',
        });
      });
    }

    const metadata: MediaMetadata = {
      title: data.title,
      author: data.author,
      duration: data.duration,
      likes: data.digg_count || data.likes,
      views: data.play_count || data.views,
      shares: data.share_count || data.shares,
      publishedAt: data.created_at ? new Date(data.created_at) : undefined,
      thumbnailUrl: data.thumbnail || data.cover,
      sourceLang: data.language || 'en',
    };

    return { metadata, srtItems };
  }

  /**
   * Download TikTok video
   */
  async downloadTikTokVideo(url: string): Promise<Buffer> {
    // Resolve short links first
    const resolvedUrl = await this.resolveTikTokShortLink(url);

    // Retry logic for RapidAPI rate limiting (429 errors)
    const retries = 3;
    let response: any;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        response = await axios.get(
          'https://tiktok-download-video1.p.rapidapi.com/getVideo',
          {
            params: { url: resolvedUrl },
            headers: {
              'x-rapidapi-host': 'tiktok-download-video1.p.rapidapi.com',
              'x-rapidapi-key': this.rapidApiKey,
            },
            responseType: 'arraybuffer',
            timeout: 120000, // 120 seconds for video download
            maxContentLength: 100 * 1024 * 1024, // 100MB limit
          }
        );
        break; // Success, exit retry loop
      } catch (error: any) {
        const isLastAttempt = attempt === retries - 1;
        const shouldRetry =
          error.response?.status === 429 || error.response?.status === 500;

        if (isLastAttempt || !shouldRetry) {
          const statusCode = error.response?.status;
          const errorMessage = statusCode === 429
            ? `TikTok video download failed: Rate limit exceeded (429). Please wait a moment and try again.`
            : `TikTok video download failed: ${error.response?.data?.message || error.message || 'Unknown error'}`;
          throw new Error(errorMessage);
        }

        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.pow(2, attempt + 1) * 1000;
        console.log(`TikTok Video Download API attempt ${attempt + 1}/${retries} failed (${error.response?.status || 'error'}), waiting ${delay / 1000}s before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return Buffer.from(response.data);
  }

  /**
   * Translate SRT items in chunks (4000 characters per chunk, max 100 items per chunk)
   */
  async translateSrtItems(
    srtItems: SrtItem[],
    targetLang: string
  ): Promise<SrtItem[]> {
    const chunks: SrtItem[][] = [];
    let currentChunk: SrtItem[] = [];
    let currentChars = 0;

    // Split into chunks
    for (const item of srtItems) {
      // Check if adding this item would exceed limits
      const wouldExceedChars = currentChars + item.text.length > 4000;
      const wouldExceedItems = currentChunk.length >= 100;

      if ((wouldExceedChars || wouldExceedItems) && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentChars = 0;
      }
      currentChunk.push(item);
      currentChars += item.text.length;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    // Translate each chunk
    for (const chunk of chunks) {
      const textsToTranslate = chunk.map((item) => item.text);

      const translatedTexts = await this.translateTexts(
        textsToTranslate,
        targetLang
      );

      // Update chunk items with translated text
      chunk.forEach((item, index) => {
        item.text = translatedTexts[index] || item.text;
      });
    }

    return srtItems;
  }

  /**
   * Translate texts using Google Translate REST API
   */
  private async translateTexts(
    texts: string[],
    targetLang: string,
    retries = 3
  ): Promise<string[]> {
    const url = 'https://translation.googleapis.com/language/translate/v2';

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await axios.post(
          url,
          {
            q: texts,
            target: targetLang,
            key: this.googleTranslateApiKey,
          },
          {
            headers: {
              'Content-Type': 'application/json',
            },
            timeout: 30000, // 30 seconds timeout
          }
        );

        if (response.data?.data?.translations) {
          return response.data.data.translations.map(
            (t: any) => t.translatedText
          );
        }

        throw new Error('Invalid translation response');
      } catch (error: any) {
        const isLastAttempt = attempt === retries - 1;
        const shouldRetry =
          error.response?.status === 429 || error.response?.status === 500;

        if (isLastAttempt || !shouldRetry) {
          throw new Error(
            `Translation failed: ${error.message || 'Unknown error'}`
          );
        }

        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.pow(2, attempt + 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return texts; // Fallback: return original texts
  }

  /**
   * Convert SRT items to SRT file string
   */
  srtItemsToString(srtItems: SrtItem[]): string {
    const parser = new Parser();
    // srt-parser-2 expects Line[] with startSeconds/endSeconds, but our SrtItem only has time strings
    // The library works fine at runtime with just time strings, so we use type assertion
    return parser.toSrt(srtItems as any);
  }

  /**
   * Parse SRT string to SRT items
   */
  parseSrtString(srtContent: string): SrtItem[] {
    const parser = new Parser();
    // parser.fromSrt may return objects with additional properties, but we only need the SrtItem fields
    return parser.fromSrt(srtContent) as SrtItem[];
  }

  /**
   * Format seconds to SRT time format (HH:MM:SS,mmm)
   */
  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds % 1) * 1000);

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
      2,
      '0'
    )}:${String(secs).padStart(2, '0')},${String(milliseconds).padStart(
      3,
      '0'
    )}`;
  }

  /**
   * Upload SRT file to storage
   */
  async uploadSrtFile(
    srtContent: string,
    fileName: string
  ): Promise<string> {
    const storageService = await getStorageService();
    const buffer = Buffer.from(srtContent, 'utf-8');

    const result = await storageService.uploadFile({
      body: buffer,
      key: `media/subtitles/${fileName}`,
      contentType: 'text/plain; charset=utf-8',
      disposition: 'inline',
    });

    if (!result.success || !result.url) {
      throw new Error(result.error || 'Failed to upload SRT file');
    }

    return result.url;
  }

  /**
   * Upload video file to storage
   */
  async uploadVideoFile(
    videoBuffer: Buffer,
    fileName: string
  ): Promise<string> {
    const storageService = await getStorageService();

    const result = await storageService.uploadFile({
      body: videoBuffer,
      key: `media/videos/${fileName}`,
      contentType: 'video/mp4',
      disposition: 'attachment',
    });

    if (!result.success || !result.url) {
      throw new Error(result.error || 'Failed to upload video file');
    }

    return result.url;
  }
}

/**
 * Get MediaProcessor instance with configs
 */
export async function getMediaProcessor(): Promise<MediaProcessor> {
  const configs = await getAllConfigs();

  const rapidApiKey = configs.rapidapi_media_key;
  const googleTranslateApiKey = configs.google_translate_api_key;

  if (!rapidApiKey) {
    throw new Error('rapidapi_media_key is not configured');
  }

  if (!googleTranslateApiKey) {
    throw new Error('google_translate_api_key is not configured');
  }

  return new MediaProcessor(rapidApiKey, googleTranslateApiKey);
}

