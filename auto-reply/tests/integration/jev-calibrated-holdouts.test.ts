import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { registerJevCalibratedHoldoutTests } from '../fixtures/jev-calibrated-holdout-suite'

registerJevCalibratedHoldoutTests(embeddedPostgres)
