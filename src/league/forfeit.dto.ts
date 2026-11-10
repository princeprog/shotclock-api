import { IsUUID } from 'class-validator';

export class ForfeitDto {
  @IsUUID() forfeitingTeamId!: string;
}
