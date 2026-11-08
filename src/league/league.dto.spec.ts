import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTeamDto } from './league.dto';

describe('team creation validation', () => {
  it.each([undefined, null, '', 'invalid'])('requires a valid season ID: %s', async (seasonId) => {
    const errors = await validate(plainToInstance(CreateTeamDto, { name: 'Hawks', seasonId }));
    expect(errors.some((error) => error.property === 'seasonId')).toBe(true);
  });

  it('accepts a valid season ID', async () => {
    const errors = await validate(plainToInstance(CreateTeamDto, { name: 'Hawks', seasonId: 'e5287e1a-e071-4609-8a5c-d3de2a694542' }));
    expect(errors).toHaveLength(0);
  });
});
