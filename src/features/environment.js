// Room environment from three Higgsfield renders in public/assets/: an
// equirectangular red-horizon skybox, a tiled black floor with a red grid, and
// a scratched stone surface on every SEELE monolith body. Each texture loads
// in the background; until it arrives (or if it fails) the room keeps its
// plain black look, so a missing file never breaks the scene.
import * as THREE from 'three';
import { BODY_MATERIAL } from '../obelisk.js';

export const SKYBOX_URL = '/assets/skybox.jpg';
export const FLOOR_URL = '/assets/floor.jpg';
export const MONOLITH_URL = '/assets/monolith.jpg';
export const FLOOR_SIZE = 180; // meters on a side, past a full aisle and the far tool monoliths
export const FLOOR_TILE = 4; // meters per texture repeat

export function install({ scene, renderer }) {
  const loader = new THREE.TextureLoader();
  const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
  const load = (url, onLoad) =>
    loader.load(url, onLoad, undefined, () => console.log(`environment: ${url} failed to load`));

  load(SKYBOX_URL, (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;
  });

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.005; // just under the grid lines
  floor.raycast = () => {}; // a click on the floor is a miss, never a select
  floor.name = 'environment:floor';
  scene.add(floor);
  load(FLOOR_URL, (tex) => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(FLOOR_SIZE / FLOOR_TILE, FLOOR_SIZE / FLOOR_TILE);
    tex.anisotropy = maxAniso;
    tex.colorSpace = THREE.SRGBColorSpace;
    floor.material.map = tex;
    floor.material.color.set(0xffffff);
    floor.material.needsUpdate = true;
  });

  load(MONOLITH_URL, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    BODY_MATERIAL.map = tex;
    BODY_MATERIAL.color.set(0xffffff);
    BODY_MATERIAL.needsUpdate = true;
  });
}
