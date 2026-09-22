import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, MaxLength } from 'class-validator';

export enum NotificationType {
  INFO = 'INFO',
  SUCCESS = 'SUCCESS',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
}

export class CreateNotificationDto {
  @ApiProperty({
    example: 'cmtkf4usd00058kymu1gwi4jy',
    description: 'Real user id from GET /users (must be a member of the active tenant)',
  })
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({ example: 'Welcome aboard' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ example: 'Your account has been set up successfully.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body!: string;

  @ApiPropertyOptional({ enum: NotificationType, example: NotificationType.INFO })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({
    example: '/activity-logs',
    description:
      'In-app path to open on click. Use a real tenant route such as /users, /roles, /settings, /activity-logs, /profile. Omit or leave empty if no deep-link is needed. Do not use /dashboard as a placeholder.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  link?: string;
}
