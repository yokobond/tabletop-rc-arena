// Table top is centered on the origin with its surface at y = 0.
export const TABLE_HALF_X = 2.4;
export const TABLE_HALF_Z = 1.6;
export const TABLE_THICKNESS = 0.12;
export const FLOOR_Y = -2.4;
export const RING_RADIUS = 1.32;

export const CAR_RADIUS = 0.2;
export const CAR_COLLISION_HEIGHT = 0.17;

export const FIXED_STEP = 1 / 120;
export const GRAVITY = 6;
/** The tallest ledge a car can roll onto without being stopped. */
export const STEP_HEIGHT = 0.09;
/** Below this y (and outside of the table) the fall counts. */
export const FALL_SCORE_Y = -0.35;

export const ACCELERATION = 7.5;
export const BOOST_ACCELERATION = 15;
export const BRAKE = 10;
export const MAX_SPEED = 2.9;
export const MAX_BOOST_SPEED = 4.6;
export const MAX_REVERSE_SPEED = 1.4;
export const ROLLING_DRAG = 0.55;
/** Engine braking when the throttle is released. */
export const COAST_DRAG = 2;
/** Applied to speed above the current limit, e.g. after a knockback. */
export const OVERSPEED_DRAG = 3.5;
export const GRIP = 7;
export const BOOST_GRIP = 4.5;
export const STUN_GRIP = 1.1;
export const STEER_RATE = 3.1;
export const STEER_RESPONSE = 10;
export const MAX_VELOCITY = 6;

export const BOOST_DRAIN = 48;
export const BOOST_REGEN = 15;
/** The gauge has to refill to this level before an empty boost can restart. */
export const BOOST_RESTART = 18;

export const CAR_RESTITUTION = 0.6;
export const KNOCKBACK_FACTOR = 0.2;
export const BOOST_KNOCKBACK = 0.8;
export const BOOST_MASS = 1.6;

export const COUNTDOWN_SECONDS = 3;
export const FALL_SECONDS = 1;
export const RESPAWN_HOVER_SECONDS = 2;
export const RESPAWN_TOTAL_SECONDS = FALL_SECONDS + RESPAWN_HOVER_SECONDS;
export const RESPAWN_HOVER_Y = 0.75;
export const INVULNERABLE_SECONDS = 1.8;
export const FINISH_DELAY_SECONDS = 1.3;
export const PROP_RESPAWN_SECONDS = 3;
