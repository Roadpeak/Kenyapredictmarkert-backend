import { IsString, IsNotEmpty, IsOptional, IsUrl, MaxLength } from 'class-validator';

export class CreateCommentDto {
  @IsString() @IsNotEmpty()
  declare marketId: string;

  @IsOptional() @IsString() @MaxLength(2000, { message: 'Comment is too long (max 2000 characters)' })
  declare body?: string;

  @IsOptional() @IsString() @IsUrl({}, { message: 'gifUrl must be a valid URL' })
  declare gifUrl?: string;

  @IsOptional() @IsString()
  declare gifId?: string;

  @IsOptional() @IsString()
  declare stickerId?: string;

  @IsOptional() @IsString()
  declare parentId?: string;
}
