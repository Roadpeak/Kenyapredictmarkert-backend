import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class CreateCommentDto {
  @IsString() @IsNotEmpty()
  declare marketId: string;

  @IsString() @IsNotEmpty() @MaxLength(2000, { message: 'Comment is too long (max 2000 characters)' })
  declare body: string;

  @IsOptional() @IsString()
  declare parentId?: string;
}
