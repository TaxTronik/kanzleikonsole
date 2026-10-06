// Erster Import von packages/db/scripts/rewrap-secret-box.ts:
// wählt das ENV-Profil „cli-secret-box“ (packages/config/src/env-schema.ts), bevor
// @taxtronik/config die ENV validiert.
import { selectEnvProfile } from '../profile';

selectEnvProfile('cli-secret-box');
