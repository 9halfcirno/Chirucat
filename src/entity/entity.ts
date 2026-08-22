import type { Session } from "../session/session";
import { uuid } from "../utils/uuid";

export class Entity {
	uuid = uuid();

	session: Session | null = null;
}