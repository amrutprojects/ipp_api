import { one, rows } from '../../db/pool';
import { AppError } from '../../http/errors';

/*
 * State → district → taluka, for the Center form. Only active ones, and nothing but their names and codes: no sign-in is
 * asked for. An unknown or deleted parent is a 404, never an empty list; an inactive one still lists its children, so a
 * record kept under it can be edited.
 */
interface Place {
  id: string;
  name: string;
  code: string | null;
}

export const geographyService = {
  states: () => rows<Place>('SELECT id, name, code FROM states WHERE is_active ORDER BY lower(name), id'),

  async districts(stateId: string) {
    const state = await one('SELECT 1 FROM states WHERE id = $1 AND deleted_at IS NULL', [stateId]);
    if (!state) throw AppError.notFound('State not found');
    return rows<Place & { stateId: string }>(
      'SELECT id, name, code, state_id AS "stateId" FROM districts WHERE state_id = $1 AND is_active ORDER BY lower(name), id',
      [stateId],
    );
  },

  async talukas(districtId: string) {
    const district = await one('SELECT 1 FROM districts WHERE id = $1 AND deleted_at IS NULL', [districtId]);
    if (!district) throw AppError.notFound('District not found');
    return rows<Place & { districtId: string }>(
      'SELECT id, name, code, district_id AS "districtId" FROM talukas WHERE district_id = $1 AND is_active ORDER BY lower(name), id',
      [districtId],
    );
  },
};
