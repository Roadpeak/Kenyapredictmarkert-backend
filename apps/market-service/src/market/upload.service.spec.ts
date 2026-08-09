import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { UploadService } from './upload.service';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockUploadStream = jest.fn();
const mockConfigCloudinary = jest.fn();

jest.mock('cloudinary', () => ({
  v2: {
    config: (...args: unknown[]) => mockConfigCloudinary(...args),
    uploader: {
      upload_stream: (...args: unknown[]) => mockUploadStream(...args),
    },
  },
}));

const mockConfig = {
  getOrThrow: jest.fn((key: string) => {
    const values: Record<string, string> = {
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'test-key',
      CLOUDINARY_API_SECRET: 'test-secret',
    };
    return values[key];
  }),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'photo.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    size: 1024,
    buffer: Buffer.from('fake-image-bytes'),
    destination: '',
    filename: '',
    path: '',
    stream: undefined as never,
    ...overrides,
  };
}

// A fake writable stream whose .end() triggers the upload_stream callback
// synchronously with either a success or an error result, mirroring how the
// real cloudinary SDK's upload_stream callback fires.
function mockStreamThatSucceeds(url: string) {
  return (_opts: unknown, callback: (err: unknown, result: unknown) => void) => ({
    end: () => callback(null, { secure_url: url }),
  });
}

function mockStreamThatFails(error: Error) {
  return (_opts: unknown, callback: (err: unknown, result: unknown) => void) => ({
    end: () => callback(error, null),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UploadService', () => {
  let service: UploadService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [UploadService, { provide: ConfigService, useValue: mockConfig }],
    }).compile();

    service = module.get<UploadService>(UploadService);
  });

  it('uploads a valid image and returns the Cloudinary secure_url', async () => {
    mockUploadStream.mockImplementation(mockStreamThatSucceeds('https://res.cloudinary.com/test-cloud/image/upload/v1/predictmarket/markets/abc.jpg'));

    const result = await service.uploadMarketImage(makeFile());

    expect(result).toEqual({ url: 'https://res.cloudinary.com/test-cloud/image/upload/v1/predictmarket/markets/abc.jpg' });
  });

  it('configures Cloudinary from ConfigService credentials before the first upload', async () => {
    mockUploadStream.mockImplementation(mockStreamThatSucceeds('https://example.com/img.jpg'));

    await service.uploadMarketImage(makeFile());

    expect(mockConfigCloudinary).toHaveBeenCalledWith({
      cloud_name: 'test-cloud',
      api_key: 'test-key',
      api_secret: 'test-secret',
    });
  });

  it('only configures Cloudinary once across multiple uploads', async () => {
    mockUploadStream.mockImplementation(mockStreamThatSucceeds('https://example.com/img.jpg'));

    await service.uploadMarketImage(makeFile());
    await service.uploadMarketImage(makeFile());

    expect(mockConfigCloudinary).toHaveBeenCalledTimes(1);
  });

  it('rejects when no file is provided', async () => {
    await expect(service.uploadMarketImage(undefined as unknown as Express.Multer.File)).rejects.toThrow(
      BadRequestException,
    );
    expect(mockUploadStream).not.toHaveBeenCalled();
  });

  it('rejects a disallowed mime type', async () => {
    await expect(service.uploadMarketImage(makeFile({ mimetype: 'application/pdf' }))).rejects.toThrow(
      BadRequestException,
    );
    expect(mockUploadStream).not.toHaveBeenCalled();
  });

  it('rejects a file over the 5MB limit', async () => {
    await expect(
      service.uploadMarketImage(makeFile({ size: 6 * 1024 * 1024 })),
    ).rejects.toThrow(BadRequestException);
    expect(mockUploadStream).not.toHaveBeenCalled();
  });

  it('accepts each of the allowed image mime types', async () => {
    mockUploadStream.mockImplementation(mockStreamThatSucceeds('https://example.com/img.jpg'));

    for (const mimetype of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      await expect(service.uploadMarketImage(makeFile({ mimetype }))).resolves.toBeDefined();
    }
  });

  it('wraps a Cloudinary upload failure in a generic InternalServerErrorException, never leaking the raw error to the client', async () => {
    mockUploadStream.mockImplementation(mockStreamThatFails(new Error('cloudinary rate limit exceeded')));

    await expect(service.uploadMarketImage(makeFile())).rejects.toThrow(InternalServerErrorException);
  });

  it('uploads into the predictmarket/markets folder', async () => {
    mockUploadStream.mockImplementation(mockStreamThatSucceeds('https://example.com/img.jpg'));

    await service.uploadMarketImage(makeFile());

    expect(mockUploadStream).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'predictmarket/markets', resource_type: 'image' }),
      expect.any(Function),
    );
  });
});
