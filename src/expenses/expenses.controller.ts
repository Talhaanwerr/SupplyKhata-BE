import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { ListExpensesQueryDto } from './dto/list-expenses-query.dto';

@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
@Controller({ path: 'expenses', version: '1' })
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Get()
  @RequirePermissions('expenses:read')
  list(@Query() query: ListExpensesQueryDto, @CurrentTenant() tenantId: string) {
    return this.expensesService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('expenses:read')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.expensesService.findOne(id, tenantId);
  }

  @Post()
  @RequirePermissions('expenses:create')
  create(
    @Body() dto: CreateExpenseDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.expensesService.create(tenantId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('expenses:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.expensesService.update(id, tenantId, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('expenses:delete')
  async remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.expensesService.remove(id, tenantId, user.id);
  }
}
