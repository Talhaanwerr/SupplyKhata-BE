import { PartialType } from '@nestjs/swagger';
import { CreateRefillBatchDto } from './create-refill-batch.dto';

export class UpdateRefillBatchDto extends PartialType(CreateRefillBatchDto) {}
