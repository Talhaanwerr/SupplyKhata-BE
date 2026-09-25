import { PartialType } from '@nestjs/swagger';
import { CreateCashHandoverDto } from './create-cash-handover.dto';

export class UpdateCashHandoverDto extends PartialType(CreateCashHandoverDto) {}
