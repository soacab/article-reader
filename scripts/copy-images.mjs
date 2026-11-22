import {constants} from "node:fs";
import {copyFile, readdir} from "node:fs/promises";
import path from "node:path";

// The caller exclusively creates the destination. Only validated image files live in source.
export async function copyImages(source, destination) {
  for (const name of await readdir(source)) {
    await copyFile(path.join(source, name), path.join(destination, name), constants.COPYFILE_EXCL);
  }
}
