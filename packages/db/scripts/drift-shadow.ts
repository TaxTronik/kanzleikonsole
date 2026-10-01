import { Client } from 'pg';

function databaseName(raw: string): string {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('Der Drift-Check benötigt PostgreSQL-Verbindungen.');
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (
    !name ||
    name.includes('/') ||
    ['postgres', 'template0', 'template1'].includes(name.toLowerCase())
  ) {
    throw new Error('Eine ausdrücklich benannte, separate Shadow-Datenbank ist erforderlich.');
  }
  return name;
}

/** A schema switch in the same database is not an isolated migration sandbox. */
export function assertSeparateShadowDatabase(shadowUrl: string, sourceUrls: string[]): string {
  const shadow = databaseName(shadowUrl);
  const schema = new URL(shadowUrl).searchParams.get('schema');
  if (schema !== null && schema !== 'public') {
    throw new Error('Die Shadow-Datenbank muss das Schema public verwenden.');
  }
  if (
    !sourceUrls.length ||
    sourceUrls.some((source) => databaseName(source).toLowerCase() === shadow.toLowerCase())
  ) {
    throw new Error('Shadow- und Ziel-Datenbank müssen unterschiedliche Datenbanknamen haben.');
  }
  return shadow;
}

/** Prisma resets public only; custom app functions otherwise survive a second run. */
export async function resetShadowAppSchema(shadowUrl: string, sourceUrls: string[]): Promise<void> {
  const expectedDatabase = assertSeparateShadowDatabase(shadowUrl, sourceUrls);
  // A pooler can map a source URL's database alias to the actual shadow name.
  // Resolve every protected source before opening the destructive connection.
  for (const sourceUrl of sourceUrls) {
    const source = new Client({ connectionString: sourceUrl });
    try {
      await source.connect();
      const identity = await source.query<{ database: string }>(
        'SELECT current_database() AS database',
      );
      if (
        !identity.rows[0]?.database ||
        identity.rows[0].database.toLowerCase() === expectedDatabase.toLowerCase()
      ) {
        throw new Error(
          'Shadow- und Ziel-Verbindung zeigen auf denselben oder einen unbekannten Datenbanknamen.',
        );
      }
    } finally {
      await source.end();
    }
  }
  const client = new Client({ connectionString: shadowUrl });
  try {
    await client.connect();
    const identity = await client.query<{ database: string }>(
      'SELECT current_database() AS database',
    );
    if (identity.rows[0]?.database !== expectedDatabase) {
      throw new Error('Die Shadow-Verbindung zeigt nicht auf die ausdrücklich benannte Datenbank.');
    }
    // Constant SQL, only after URL and live database identity checks. All
    // dependent public objects are rebuilt by the subsequent Prisma reset.
    await client.query('DROP SCHEMA IF EXISTS app CASCADE');
  } finally {
    await client.end();
  }
}
