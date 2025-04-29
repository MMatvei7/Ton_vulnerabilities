import { address, toNano } from "ton-core";
import { MainContract } from "../wrappers/MainContract";
import { compile, NetworkProvider } from "@ton/blueprint";

export async function run(provider: NetworkProvider) {
  
  const myContract = MainContract.createFromConfig(
    {
      number: 0,
      address: address("kQAfylJtX6ER1jVSb2SL64mjRsXrgn0xvLHmcOQm4vJ9ME5T"),
      owner_address: address(
        "kQAfylJtX6ER1jVSb2SL64mjRsXrgn0xvLHmcOQm4vJ9ME5T"
      ),
    },
    await compile("MainContract")
  );

  const openedContract = provider.open(myContract);

  openedContract.sendDeploy(provider.sender(), toNano("0.05"));

  await provider.waitForDeploy(myContract.address);
}