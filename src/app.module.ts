import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AccountsModule } from './accounts/accounts.module';
import { TransfersModule } from './transfers/transfers.module';
import { LedgerModule } from './ledger/ledger.module';
import { IdempotencyModule } from './idempotency/idempotency.module';

@Module({
  imports: [AccountsModule, TransfersModule, LedgerModule, IdempotencyModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
