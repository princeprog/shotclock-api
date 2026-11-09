import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTeamDto, PlayerDto, RosterDto, UpdatePlayerDto } from './league.dto';

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

describe('player validation', () => {
  it('accepts a partial date of birth update for a legacy player', async () => {
    expect(await validate(plainToInstance(UpdatePlayerDto, { dateOfBirth: '2000-01-01' }))).toHaveLength(0);
  });

  it('accepts the documented positions and rejects unsupported positions', async () => {
    const player = { firstName: 'A', lastName: 'Player', dateOfBirth: '2000-01-01' };
    expect(await validate(plainToInstance(PlayerDto, { ...player, position: 'point_guard' }))).toHaveLength(0);
    expect((await validate(plainToInstance(PlayerDto, { ...player, position: 'coach' }))).some((error) => error.property === 'position')).toBe(true);
  });
});

describe('roster registration validation', () => {
  it('requires an existing player ID', async () => {
    const errors = await validate(plainToInstance(RosterDto, { firstName: 'Old', lastName: 'Contract' }));
    expect(errors.some((error) => error.property === 'playerId')).toBe(true);
  });

  it('accepts a player ID and optional jersey number', async () => {
    const errors = await validate(plainToInstance(RosterDto, { playerId: 'e5287e1a-e071-4609-8a5c-d3de2a694542', jerseyNumber: 7 }));
    expect(errors).toHaveLength(0);
  });
});
