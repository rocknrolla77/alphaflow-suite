// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/// @title SentinelIdentity — ERC-8004 Identity Core
/// @notice Реестр агентов: каждый кошелёк может зарегистрировать ровно одного AI-агента.
/// @dev Soulbound-подобная механика: один адрес = один tokenId. Нет transfer restriction
///      (при необходимости добавить _beforeTokenTransfer override для full soulbound).
contract SentinelIdentity is ERC721URIStorage {
    // ═══════════════════════════════════════════════════════════════════
    //                          ERRORS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Адрес уже зарегистрировал агента (1 адрес = 1 агент)
    error AgentAlreadyRegistered();

    /// @notice Вызывающий не является владельцем указанного tokenId
    error NotTokenOwner();

    // ═══════════════════════════════════════════════════════════════════
    //                          EVENTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Эмитируется при регистрации нового агента
    event AgentRegistered(uint256 indexed tokenId, address indexed owner, string agentCardURI);

    /// @notice Эмитируется при обновлении Agent Card URI
    event AgentCardUpdated(uint256 indexed tokenId, string newURI);

    // ═══════════════════════════════════════════════════════════════════
    //                          STORAGE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Монотонный счётчик tokenId
    uint256 private _nextTokenId;

    /// @notice Маппинг: адрес владельца → его tokenId (0 = не зарегистрирован)
    /// @dev tokenId начинается с 1, поэтому 0 — индикатор отсутствия
    mapping(address => uint256) public agentOf;

    // ═══════════════════════════════════════════════════════════════════
    //                          CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor() ERC721("Sentinel Identity", "SID") {}

    // ═══════════════════════════════════════════════════════════════════
    //                      EXTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Регистрация нового AI-агента. Один адрес — один агент.
    /// @param agentCardURI URI метаданных агента (JSON, соответствующий ERC-8004 Agent Card)
    /// @return tokenId Идентификатор зарегистрированного агента
    function registerAgent(string calldata agentCardURI) external returns (uint256 tokenId) {
        // CHECKS
        if (agentOf[msg.sender] != 0) revert AgentAlreadyRegistered();

        // EFFECTS
        unchecked {
            tokenId = ++_nextTokenId; // overflow невозможен в пределах uint256
        }
        agentOf[msg.sender] = tokenId;

        // INTERACTIONS (mint + setTokenURI — внутренние, safe)
        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, agentCardURI);

        emit AgentRegistered(tokenId, msg.sender, agentCardURI);
    }

    /// @notice Обновление Agent Card URI. Только владелец токена.
    /// @param tokenId ID агента для обновления
    /// @param newURI Новый URI метаданных
    function updateAgentCard(uint256 tokenId, string calldata newURI) external {
        // CHECKS
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

        // EFFECTS + INTERACTIONS
        _setTokenURI(tokenId, newURI);

        emit AgentCardUpdated(tokenId, newURI);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Общее количество зарегистрированных агентов
    function totalAgents() external view returns (uint256) {
        return _nextTokenId;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      OVERRIDES
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Required override for ERC721URIStorage
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    /// @dev Required override for ERC721URIStorage
    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }
}
