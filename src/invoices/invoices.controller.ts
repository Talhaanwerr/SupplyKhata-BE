import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { InvoicesService } from './invoices.service';
import { GenerateInvoiceDto } from './dto/generate-invoice.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { VoidInvoiceDto } from './dto/void-invoice.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'invoices', version: '1' })
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Post('generate')
  @RequirePermissions('invoices:create')
  generate(
    @Body() dto: GenerateInvoiceDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invoicesService.generate(tenantId, dto, user.id);
  }

  @Get()
  @RequirePermissions('invoices:read')
  list(@Query() query: ListInvoicesQueryDto, @CurrentTenant() tenantId: string) {
    return this.invoicesService.list(tenantId, query);
  }

  @Get(':id/pdf')
  @RequirePermissions('invoices:read')
  pdf(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return this.invoicesService.pdf(id, tenantId, res);
  }

  @Get(':id')
  @RequirePermissions('invoices:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.invoicesService.findOne(id, tenantId);
  }

  @Post(':id/issue')
  @RequirePermissions('invoices:update')
  issue(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invoicesService.issue(id, tenantId, user.id);
  }

  @Post(':id/void')
  @RequirePermissions('invoices:void')
  voidInvoice(
    @Param('id') id: string,
    @Body() dto: VoidInvoiceDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invoicesService.voidInvoice(id, tenantId, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('invoices:delete')
  async remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.invoicesService.removeDraft(id, tenantId, user.id);
  }
}
