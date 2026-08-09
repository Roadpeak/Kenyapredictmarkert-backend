import { Injectable, BadRequestException, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private configured = false;

  constructor(private readonly config: ConfigService) {}

  private ensureConfigured() {
    if (this.configured) return;
    cloudinary.config({
      cloud_name: this.config.getOrThrow<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.config.getOrThrow<string>('CLOUDINARY_API_KEY'),
      api_secret: this.config.getOrThrow<string>('CLOUDINARY_API_SECRET'),
    });
    this.configured = true;
  }

  async uploadMarketImage(file: Express.Multer.File): Promise<{ url: string }> {
    if (!file) {
      throw new BadRequestException('No file provided.');
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG, WebP, and GIF images are allowed.');
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException('Image must be smaller than 5MB.');
    }

    this.ensureConfigured();

    try {
      const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'predictmarket/markets', resource_type: 'image' },
          (err, uploadResult) => {
            if (err || !uploadResult) return reject(err ?? new Error('Empty Cloudinary response'));
            resolve(uploadResult as { secure_url: string });
          },
        );
        stream.end(file.buffer);
      });

      return { url: result.secure_url };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Cloudinary upload failed: ${msg}`);
      throw new InternalServerErrorException('Image upload failed. Please try again.');
    }
  }
}
