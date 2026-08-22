import { Session } from "inspector";
import { Entity } from "./entity";

export class Message extends Entity {
	text: string;
	session: Session = new Session();

	constructor(text: string) {
		super();
		this.text = text;
	}
}