// Erster Import von packages/storage/scripts/deploy-readiness.ts:
// wählt das ENV-Profil „cli-storage“ (packages/config/src/env-schema.ts), bevor
// @taxtronik/config die ENV validiert.
import { selectEnvProfile } from '../profile';

selectEnvProfile('cli-storage');
