import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** Used for enable, disable, and any endpoint that just needs a TOTP code. */
export class TotpCodeDto {
  @ApiProperty({ example: '123456', description: '6-digit TOTP code from the authenticator app' })
  @IsString()
  @Length(6, 6, { message: 'code must be exactly 6 digits' })
  code!: string;
}
