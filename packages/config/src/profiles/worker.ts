// Erster Import des Worker-Einstiegs (apps/worker/src/index.ts):
// wählt das ENV-Profil „worker“ (packages/config/src/env-schema.ts), bevor
// @taxtronik/config die ENV validiert.
import { selectEnvProfile } from '../profile';

selectEnvProfile('worker');
