import { one, pool, rows, transaction, type Db } from '../../db/pool';
import { AppError } from '../../http/errors';
import { record, type By } from './common.service';
import type { DistrictTechnologiesBody } from './technologies.schemas';

/*
 * The technologies offered to the students of a district. None selected, or none of the selected ones active any more: every
 * active technology (`all`). `codes` also has the selected ones that are switched off.
 */
interface DistrictTechnologies {
  district_id: string;
  district: string;
  all: boolean;
  codes: string[];
}

const districts = (db: Db, districtId: string | null) =>
  rows<DistrictTechnologies>(
    `SELECT d.id AS district_id, d.name AS district, NOT coalesce(bool_or(o.is_active), false) AS all,
            coalesce(array_agg(o.code::text ORDER BY o.display_order, o.code) FILTER (WHERE o.id IS NOT NULL), '{}') AS codes
     FROM districts d
     LEFT JOIN district_technologies t ON t.district_id = d.id
     LEFT JOIN program_options o ON o.id = t.option_id AND o.kind = 'TECHNOLOGY' AND o.deleted_at IS NULL
     WHERE d.deleted_at IS NULL AND (d.id = $1::uuid OR ($1::uuid IS NULL AND d.is_active))
     GROUP BY d.id ORDER BY lower(d.name), d.id`,
    [districtId],
    db,
  );

export const technologiesService = {
  /* The active districts, A to Z. */
  list: () => districts(pool, null),

  /* Replaces the technologies selected for a district (also an inactive one); none = all. */
  save(who: By, districtId: string, body: DistrictTechnologiesBody) {
    return transaction(async (db) => {
      const district = await one('SELECT 1 FROM districts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [districtId], db);
      if (!district) throw AppError.notFound('District not found');
      const options = await rows<{ id: string }>(
        `SELECT id FROM program_options WHERE kind = 'TECHNOLOGY' AND deleted_at IS NULL AND upper(code) = ANY($1::text[])`,
        [body.codes],
        db,
      );
      if (options.length !== body.codes.length)
        throw AppError.validation([{ field: 'body.codes', message: 'Choose technologies of the Technology master only' }]);
      await db.query('DELETE FROM district_technologies WHERE district_id = $1', [districtId]);
      await db.query('INSERT INTO district_technologies (district_id, option_id) SELECT $1, x FROM unnest($2::uuid[]) AS x', [
        districtId,
        options.map((o) => o.id),
      ]);
      await record(db, who, 'edp.master.district_technologies', 'district', districtId, { count: options.length });
      return (await districts(db, districtId))[0]!;
    });
  },
};
